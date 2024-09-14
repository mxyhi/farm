import { UserConfig, UserPreviewServerConfig } from '../config/types.js';
import { httpServer as HttpServer } from './http.js';

class PreviewServer extends HttpServer {
  previewOptions: UserPreviewServerConfig;

  constructor(readonly inlineConfig: UserConfig) {
    super();
    this.previewOptions = inlineConfig.preview;
  }
}

export { PreviewServer };
