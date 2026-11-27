import { toast } from 'sonner';
import { describeError, errorCode } from './errors';
import { gmi } from './gmi';

/** One toast for sign-in failures: a re-opened flow that fails again updates it instead of stacking. */
export const SIGN_IN_ERROR_TOAST_ID = 'gmi-sign-in-error';

/** Shows a failed action as an error toast. Cancellations are silent. */
export function toastError(title: string, error: unknown, opts: { id?: string } = {}): void {
  if (errorCode(error) === 'cancelled') return;
  const view = describeError(error);
  const description = view.message ? `${view.title} (${view.message})` : view.title;
  toast.error(title, { id: opts.id, description });
}

/**
 * Starts the browser sign-in, or re-opens its page while one is pending (the main process joins the running
 * flow). Buttons in the top bar, error notices and the palette have no room for an inline error, so failures
 * (network, timeout, GMI refusing) show as a toast. Resolves false when the sign-in failed.
 */
export async function signInWithFeedback(): Promise<boolean> {
  try {
    await gmi.auth.signIn();
    return true;
  } catch (error) {
    toastError('Sign-in failed', error, { id: SIGN_IN_ERROR_TOAST_ID });
    return false;
  }
}

/** Abandons a pending browser sign-in (the pending signIn() then resolves without an error). */
export async function cancelSignIn(): Promise<void> {
  try {
    await gmi.auth.cancelSignIn();
  } catch (error) {
    toastError('Could not cancel the sign-in', error);
  }
}
