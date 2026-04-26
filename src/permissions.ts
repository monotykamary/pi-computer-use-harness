/**
 * Permission checking for the harness server context.
 *
 * The interactive permission grant flow (with ctx.ui.select / ctx.ui.notify)
 * has been removed — the harness server runs outside pi's process and has
 * no access to ExtensionContext. Users must grant permissions via interactive
 * pi or System Settings before using the CLI.
 */

export interface PermissionStatus {
	accessibility: boolean;
	screenRecording: boolean;
}


