import type { MenuItemConstructorOptions } from 'electron';

/**
 * Application menu used outside development (Electron's default menu stays in dev).
 *
 * Deliberately absent: reload / force reload (Ctrl/Cmd+R would throw away unsent drafts and the Create form),
 * close window (Ctrl+W quits the app on Windows/Linux, aborting a streaming reply), and DevTools
 * (Ctrl+Shift+I invites "paste this into the console" self-XSS).
 * Kept: Edit (copy/paste need it on macOS), zoom and full screen (readability), Quit and the macOS app menu.
 * On Windows/Linux the window hides the menu bar (autoHideMenuBar), so this only provides the accelerators.
 */
export function productionMenuTemplate(platform: NodeJS.Platform, appName: string): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  const edit: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(mac ? [{ role: 'pasteAndMatchStyle' } as const] : []),
      { role: 'delete' },
      { type: 'separator' },
      { role: 'selectAll' },
    ],
  };
  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
  };
  if (!mac) return [{ label: 'File', submenu: [{ role: 'quit' }] }, edit, view];
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    edit,
    view,
    { label: 'Window', role: 'window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
  ];
}

/** Every role in a template, depth-first (for tests and logging). */
export function menuRoles(template: MenuItemConstructorOptions[]): string[] {
  const roles: string[] = [];
  const walk = (items: MenuItemConstructorOptions[]) => {
    for (const item of items) {
      if (item.role) roles.push(item.role);
      if (Array.isArray(item.submenu)) walk(item.submenu as MenuItemConstructorOptions[]);
    }
  };
  walk(template);
  return roles;
}
