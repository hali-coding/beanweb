import { useDesktop } from '@/store/desktop'
import { useFs } from '@/store/fs'

/**
 * Confirm, then restore the seeded disk.
 *
 * Lives here rather than in either caller because About and Preferences both
 * offer it, and a destructive action's wording must not be able to drift
 * between the two places that offer it. Reads the stores through `getState()`
 * for the same reason `launchApp` does -- it is an action, not a subscription,
 * and nothing renders from it.
 *
 * Resolves true only if the disk was actually reset.
 */
export async function confirmResetDisk(): Promise<boolean> {
  const answer = await useDesktop.getState().showAlert(
    'stop',
    'Reset filesystem',
    'Every file you have created or edited will be discarded and the\noriginal disk contents restored.\n\nThis cannot be undone.',
    ['Cancel', 'Reset'],
    0,
  )
  if (answer !== 1) return false
  useFs.getState().reset()
  return true
}
