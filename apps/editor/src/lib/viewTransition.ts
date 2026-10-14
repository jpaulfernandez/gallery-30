import { flushSync } from 'react-dom';

/**
 * Run `update` as a view transition when the browser has `document.startViewTransition` (the DOM change is flushed
 * inside it), else at once: a cut. Plan 47 wrote it for Survey; plan 49 uses it for Develop opening over a project's
 * Cull. The durations are the tokens' (`styles.css`), so reduced motion makes every transition a cut.
 */
export function withViewTransition(update: () => void): void {
  if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function') {
    update();
    return;
  }
  // A transition the browser skips (the window hidden, another one starting) still runs `update`; its `ready` rejects.
  const transition = document.startViewTransition(() => flushSync(update)) as ViewTransition | undefined;
  transition?.ready.catch(() => {});
}

/**
 * The picture that stays put across a stage change (ODDHALLS_UI_PLAN 4.4): One's picture in Cull and the Develop
 * picture carry this `view-transition-name`, so the stage crossfade moves it instead of fading it.
 */
export const STAGE_PICTURE = 'stage-picture';

export type StageName = 'home' | 'cull' | 'develop' | 'design' | 'other';

/** Which stage a route's pathname shows (the router's code routes, `router.tsx`). */
export function stageOf(pathname: string): StageName {
  if (pathname === '/' || pathname === '') return 'home';
  if (/^\/(library\/(collection\/)?[^/]+|project\/[^/]+)\/cull$/.test(pathname)) return 'cull';
  if (/^\/library\/(collection\/)?[^/]+\/develop$/.test(pathname)) return 'develop';
  if (/^\/project\/[^/]+\/design(\/|$)/.test(pathname)) return 'design';
  return 'other';
}

/**
 * Whether a navigation from `from` to `to` changes the stage (Cull, Develop, Design): those get the crossfade. Moves
 * inside a stage (another folder, another document of the project, a redirect to the same stage) and every other
 * route change are cuts, as before.
 */
export function isStageChange(from: string | undefined, to: string): boolean {
  if (from === undefined) return false;
  const a = stageOf(from);
  const b = stageOf(to);
  const stages: StageName[] = ['cull', 'develop', 'design'];
  return a !== b && stages.includes(a) && stages.includes(b);
}
