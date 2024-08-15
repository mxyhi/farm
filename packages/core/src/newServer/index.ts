import fs, { PathLike } from 'node:fs';
import type * as http from 'node:http';
import type {
  ServerOptions as HttpsServerOptions,
  IncomingMessage,
  OutgoingHttpHeaders,
  Server
} from 'node:http';
import type { Http2SecureServer } from 'node:http2';
import path from 'node:path';
import { WatchOptions } from 'chokidar';
import compression from 'compression';
import connect from 'connect';
import corsMiddleware from 'cors';
import fse from 'fs-extra';
import { WebSocketServer as WebSocketServerRaw_ } from 'ws';
import { Compiler } from '../compiler/index.js';
import { normalizePublicPath } from '../config/normalize-config/normalize-output.js';
import { NormalizedServerConfig, ResolvedUserConfig } from '../config/types.js';
import { logError } from '../server/error.js';
import { getCacheDir, isCacheDirExists } from '../utils/cacheDir.js';
import { Logger, bootstrap, logger } from '../utils/logger.js';
import { initPublicFiles } from '../utils/publicDir.js';
import { isObject } from '../utils/share.js';
import { FileWatcher } from '../watcher/index.js';
import { HmrEngine } from './hmr-engine.js';
import { HMRChannel } from './hmr.js';
import { CommonServerOptions, httpServer } from './http.js';
import {
  adaptorViteMiddleware,
  hmrPingMiddleware,
  htmlFallbackMiddleware,
  lazyCompilationMiddleware,
  notFoundMiddleware,
  proxyMiddleware,
  publicMiddleware,
  publicPathMiddleware,
  resourceMiddleware
} from './middlewares/index.js';

import { createCompiler } from '../index.js';
import { WebSocketClient, WebSocketServer, WsServer } from './ws.js';

export type HttpServer = Server | Http2SecureServer;

type CompilerType = Compiler | null;

export interface HmrOptions {
  protocol?: string;
  host?: string;
  port?: number;
  clientPort?: number;
  path?: string;
  timeout?: number;
  overlay?: boolean;
  server?: Server;
  /** @internal */
  channels?: HMRChannel[];
}

export interface ServerOptions extends CommonServerOptions {
  /**
   * Configure HMR-specific options (port, host, path & protocol)
   */
  hmr?: HmrOptions | boolean;
  /**
   * Do not start the websocket connection.
   * @experimental
   */
  ws?: false;
  /**
   * chokidar watch options or null to disable FS watching
   * https://github.com/paulmillr/chokidar#api
   */
  watchOptions?: WatchOptions | null;
  /**
   * Create dev server to be used as a middleware in an existing server
   * @default false
   */
  middlewareMode?:
    | boolean
    | {
        /**
         * Parent server instance to attach to
         *
         * This is needed to proxy WebSocket connections to the parent server.
         */
        server: http.Server;
      };
  origin?: string;
}

export function noop() {
  // noop
}

export class newServer extends httpServer {
  ws: any;
  serverOptions: CommonServerOptions & NormalizedServerConfig;
  httpsOptions: HttpsServerOptions;
  // public assets directory
  publicDir?: string | boolean;
  // base path of server
  publicPath?: string;
  // publicFile
  publicFiles?: Set<string>;
  httpServer: HttpServer;
  watcher: FileWatcher;
  hmrEngine?: HmrEngine;
  middlewares: connect.Server;
  compiler: CompilerType;
  constructor(
    // private compiler: CompilerType,
    private readonly resolvedUserConfig: ResolvedUserConfig,
    readonly logger: Logger
  ) {
    super(logger);
    this.resolveOptions(resolvedUserConfig);
  }

  public getCompiler(): CompilerType {
    return this.compiler;
  }

  private resolveOptions(config: ResolvedUserConfig) {
    this.publicPath = config.compilation.output.publicPath;
    this.publicDir = config.compilation.assets.publicDir;

    this.serverOptions = config.server as CommonServerOptions &
      NormalizedServerConfig;
  }

  public async createServer() {
    try {
      const { https, middlewareMode } = this.serverOptions;

      this.httpsOptions = await this.resolveHttpsConfig(https);
      this.publicFiles = await this.handlePublicFiles();

      this.middlewares = connect() as connect.Server;
      this.httpServer = middlewareMode
        ? null
        : await this.resolveHttpServer(
            this.serverOptions as CommonServerOptions,
            this.middlewares,
            this.httpsOptions
          );

      // init hmr engine When actually updating, we need to get the clients of ws for broadcast, 、
      // so we can instantiate hmrEngine by default at the beginning.
      this.createHmrEngine();

      // init websocket server
      this.createWebSocketServer();

      // invalidate vite handler
      this.invalidateVite();

      // init middlewares
      this.initializeMiddlewares();
    } catch (error) {
      throw new Error(`handle create farm server error: ${error}`);
    }
  }

  private initializeMiddlewares() {
    this.middlewares.use(hmrPingMiddleware());

    const { proxy, middlewareMode, cors } = this.serverOptions;

    if (cors) {
      this.middlewares.use(
        corsMiddleware(typeof cors === 'boolean' ? {} : cors)
      );
    }

    if (proxy) {
      const middlewareServer =
        (isObject(middlewareMode) ? middlewareMode.server : null) ??
        this.httpServer;
      this.middlewares.use(proxyMiddleware(this, middlewareServer));
    }

    if (this.publicPath !== '/') {
      this.middlewares.use(publicPathMiddleware(this));
    }

    if (fs.existsSync(this.publicDir as PathLike)) {
      this.middlewares.use(publicMiddleware(this));
    }

    if (this.resolvedUserConfig.compilation.lazyCompilation) {
      this.middlewares.use(lazyCompilationMiddleware(this));
    }

    // TODO todo add appType 这块要判断 单页面还是 多页面 多 html 处理不一样
    this.middlewares.use(htmlFallbackMiddleware(this));

    this.middlewares.use(resourceMiddleware(this));

    this.middlewares.use(adaptorViteMiddleware(this));

    this.middlewares.use(notFoundMiddleware());
  }

  public createHmrEngine() {
    if (!this.httpServer) {
      throw new Error(
        'HmrEngine requires a http server. please check the server is be created'
      );
    }

    this.hmrEngine = new HmrEngine(this);
  }

  public async createWebSocketServer() {
    if (!this.httpServer) {
      throw new Error(
        'Websocket requires a http server. please check the server is be created'
      );
    }

    this.ws = new WsServer(this);
  }

  public async listen(): Promise<void> {
    if (!this.httpServer) {
      this.logger.warn('HTTP server is not created yet');
      return;
    }
    // TODO open browser when server is ready && open config is true
    const { port, hostname, protocol, strictPort } = this.serverOptions;

    try {
      const serverPort = await this.httpServerStart({
        port,
        strictPort: strictPort,
        host: hostname.host
      });

      // 这块要重新设计 restart 还有 端口冲突的问题
      // this.resolvedUserConfig
      this.resolvedUserConfig.compilation.define.FARM_HMR_PORT =
        serverPort.toString();

      this.compiler = await createCompiler(this.resolvedUserConfig, logger);

      // compile the project and start the dev server
      await this.startCompilation();

      // watch extra files after compile
      this.watcher?.watchExtraFiles?.();

      console.log(`Server running at ${protocol}://${hostname.name}:${port}/`);
    } catch (error) {
      this.logger.error(`start farm dev server error: ${error}`);
      throw error;
    }
  }

  addWatchFile(root: string, deps: string[]): void {
    this.getCompiler().addExtraWatchFile(root, deps);
  }

  setCompiler(compiler: Compiler) {
    this.compiler = compiler;
  }

  private async compile(): Promise<void> {
    try {
      await this.compiler.compile();
    } catch (err) {
      throw new Error(logError(err) as unknown as string);
    }

    if (this.resolvedUserConfig.server.writeToDisk) {
      this.compiler.writeResourcesToDisk();
    } else {
      this.compiler.callWriteResourcesHook();
    }
  }

  protected async httpServerStart(serverOptions: {
    port: number;
    strictPort: boolean | undefined;
    host: string | undefined;
  }): Promise<number> {
    if (!this.httpServer) {
      throw new Error('httpServer is not initialized');
    }

    let { port, strictPort, host } = serverOptions;

    return new Promise((resolve, reject) => {
      const onError = (e: Error & { code?: string }) => {
        if (e.code === 'EADDRINUSE') {
          if (strictPort) {
            this.httpServer.removeListener('error', onError);
            reject(new Error(`Port ${port} is already in use`));
          } else {
            console.info(`Port ${port} is in use, trying another one...`);
            this.httpServer.listen(++port, host);
          }
        } else {
          this.httpServer.removeListener('error', onError);
          reject(e);
        }
      };

      this.httpServer.on('error', onError);

      this.httpServer.listen(port, host, () => {
        this.httpServer.removeListener('error', onError);
        resolve(port);
      });
    });
  }

  private async startCompilation() {
    // check if cache dir exists
    const { root, persistentCache } = this.compiler.config.config;
    const hasCacheDir = await isCacheDirExists(
      getCacheDir(root, persistentCache)
    );
    const start = performance.now();
    await this.compile();
    const duration = performance.now() - start;
    bootstrap(duration, this.compiler.config, hasCacheDir);
  }

  private async handlePublicFiles() {
    const initPublicFilesPromise = initPublicFiles(this.resolvedUserConfig);
    return await initPublicFilesPromise;
  }

  private invalidateVite() {
    // Note: path should be Farm's id, which is a relative path in dev mode,
    // but in vite, it's a url path like /xxx/xxx.js
    this.ws.wss.on('vite:invalidate', ({ path, message }: any) => {
      // find hmr boundary starting from the parent of the file
      this.logger.info(`HMR invalidate: ${path}. ${message ?? ''} `);
      const parentFiles = this.compiler.getParentFiles(path);
      this.hmrEngine.hmrUpdate(parentFiles, true);
    });
  }
}
