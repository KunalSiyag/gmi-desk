import { CONSOLE_PAGES, consoleUrl, isAllowedExternalUrl, type ConsolePage } from '@shared/app';
import type { AppApi, AppInfo, AppSettings } from '@shared/contracts/app';
import { GmiError } from '@shared/contracts/errors';
import type { AppContext } from '../../core/context';
import { isInsideDir } from '../../core/media-paths';

export function createAppApi(ctx: AppContext, getInfo: () => AppInfo): AppApi {
  return {
    async info() {
      return getInfo();
    },
    async getSettings() {
      return ctx.settings.get();
    },
    async updateSettings(patch: Partial<AppSettings>) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new GmiError('invalid_input', 'Settings patch must be an object.');
      }
      return ctx.settings.update(patch);
    },
    async openExternal(url: string) {
      if (typeof url !== 'string' || !isAllowedExternalUrl(url)) {
        throw new GmiError('invalid_input', 'That link is not allowed.');
      }
      await ctx.platform.openExternal(url);
    },
    async openConsole(page: ConsolePage) {
      if (typeof page !== 'string' || !Object.hasOwn(CONSOLE_PAGES, page)) {
        throw new GmiError('invalid_input', `Unknown console page: ${String(page)}`);
      }
      await ctx.platform.openExternal(consoleUrl(page));
    },
    async showItemInFolder(path: string) {
      if (typeof path !== 'string' || !(isInsideDir(ctx.paths.media, path) || isInsideDir(ctx.paths.exports, path) || isInsideDir(ctx.paths.logs, path))) {
        throw new GmiError('invalid_input', 'That file is outside the app folders.');
      }
      ctx.platform.showItemInFolder(path);
    },
  };
}
