import { describe, expect, it } from 'vitest';
import { isStageChange, stageOf } from './viewTransition';

const F = '01K7F000000000000000000000';
const P = '01K7P000000000000000000000';

describe('the stage crossfade (plan 49)', () => {
  it('reads the stage of every route', () => {
    expect(stageOf('/')).toBe('home');
    expect(stageOf(`/library/${F}/cull`)).toBe('cull');
    expect(stageOf('/library/collection/picks/cull')).toBe('cull');
    expect(stageOf(`/project/${P}/cull`)).toBe('cull');
    expect(stageOf(`/library/${F}/develop`)).toBe('develop');
    expect(stageOf('/library/collection/picks/develop')).toBe('develop');
    expect(stageOf(`/project/${P}/design`)).toBe('design');
    expect(stageOf(`/project/${P}/design/book`)).toBe('design');
    expect(stageOf('/settings')).toBe('other');
    expect(stageOf(`/project/${P}/preview`)).toBe('other');
  });

  it('crossfades between Cull, Develop and Design only', () => {
    const cull = `/library/${F}/cull`;
    const develop = `/library/${F}/develop`;
    const design = `/project/${P}/design/book`;
    expect(isStageChange(cull, develop)).toBe(true);
    expect(isStageChange(develop, cull)).toBe(true);
    expect(isStageChange(develop, design)).toBe(true);
    expect(isStageChange(design, `/project/${P}/cull`)).toBe(true);
    // Home, other routes, the same stage and a first load are cuts.
    expect(isStageChange('/', cull)).toBe(false);
    expect(isStageChange(cull, '/')).toBe(false);
    expect(isStageChange(cull, '/settings')).toBe(false);
    expect(isStageChange('/settings', develop)).toBe(false);
    expect(isStageChange(cull, '/library/collection/picks/cull')).toBe(false);
    expect(isStageChange(`/project/${P}/design`, design)).toBe(false);
    expect(isStageChange(undefined, develop)).toBe(false);
  });
});
