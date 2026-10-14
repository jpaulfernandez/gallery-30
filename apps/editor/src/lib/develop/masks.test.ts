import { createDevelop, DevelopMaskSchema, type DevelopPoint } from '@photobook/shared';
import { describe, expect, it } from 'vitest';
import { applyMat } from './geometry';
import {
  aiPrimaryTask,
  appendStrokePoint,
  approximateMask,
  cloneMask,
  componentLabel,
  cropMapping,
  DEPTH_RANGE_DEFAULT,
  encodedLuminance,
  extendRange,
  finishStroke,
  frameDistance,
  frameMetric,
  isAiOutdated,
  isMaskEmpty,
  maskDisplayName,
  newAi,
  newBrushComponent,
  newColor,
  newLinear,
  newLuminance,
  newMask,
  newRadial,
  nextMaskName,
  promptFrom,
  rangeAround,
  simplifyStroke,
  stampAi,
  toHex,
} from './masks';

const SIZE = { width: 1200, height: 800 };
const stroke = (points: DevelopPoint[], erase = false) => ({ points, size: 10, feather: 50, flow: 100, erase });

describe('mask factories', () => {
  it('build masks the schema accepts, with fresh ids and zero adjustments', () => {
    const kinds = [
      newBrushComponent(),
      newLinear([0.5, 0], [0.5, 1]),
      newRadial([0.5, 0.5], [0.2, 0.3]),
      newLuminance(),
      newColor(['#ff0000']),
    ];
    for (const c of kinds) {
      const m = newMask('Mask 1', c);
      expect(DevelopMaskSchema.parse(m)).toEqual(m);
      expect(m.components[0]?.mode).toBe('add');
      expect(Object.values(m.adjustments).every((v) => v === 0)).toBe(true);
    }
    expect(new Set(kinds.map((c) => c.id)).size).toBe(kinds.length);
    expect(newLinear([0, 0], [1, 1], 'subtract').mode).toBe('subtract');
    expect(newMask('x', newBrushComponent(), 'fixed').id).toBe('fixed');
  });

  it('copies a mask with new ids for it and its components', () => {
    const m = newMask('Sky', newLinear([0, 0], [0, 1]));
    const copy = cloneMask(m, 'Sky copy');
    expect(copy.id).not.toBe(m.id);
    expect(copy.components[0]?.id).not.toBe(m.components[0]?.id);
    expect(copy.name).toBe('Sky copy');
    expect({ ...copy.components[0], id: '' }).toEqual({ ...m.components[0], id: '' });
  });

  it('names masks and tells empty ones', () => {
    const a = newMask('', newBrushComponent());
    expect(maskDisplayName(a, 2)).toBe('Mask 3');
    expect(nextMaskName([newMask('Mask 2', newBrushComponent())])).toBe('Mask 3');
    expect(nextMaskName([newMask('Mask 2', newBrushComponent()), newMask('Mask 3', newBrushComponent())])).toBe(
      'Mask 4',
    );
    expect(isMaskEmpty(a)).toBe(true);
    expect(isMaskEmpty(newMask('', newBrushComponent([stroke([[0.1, 0.1]], true)])))).toBe(true);
    expect(isMaskEmpty(newMask('', newBrushComponent([stroke([[0.1, 0.1]])])))).toBe(false);
    expect(isMaskEmpty(newMask('', newColor()))).toBe(true);
    expect(isMaskEmpty(newMask('', newLinear([0, 0], [1, 1])))).toBe(false);
  });
});

describe('strokes', () => {
  const m = frameMetric(1.5);

  it('measures in short-side units', () => {
    expect(m).toEqual({ sx: 1.5, sy: 1 });
    expect(frameDistance([0, 0], [1, 0], m)).toBeCloseTo(1.5);
    expect(frameMetric(0.5)).toEqual({ sx: 1, sy: 2 });
  });

  it('appends points no closer than the spacing', () => {
    let pts: DevelopPoint[] = [];
    pts = appendStrokePoint(pts, [0.1, 0.1], 0.01, m);
    const same = appendStrokePoint(pts, [0.101, 0.1], 0.01, m);
    expect(same).toBe(pts);
    pts = appendStrokePoint(pts, [0.12, 0.1], 0.01, m);
    expect(pts).toEqual([
      [0.1, 0.1],
      [0.12, 0.1],
    ]);
  });

  it('simplifies a straight run to its ends and keeps corners', () => {
    const line: DevelopPoint[] = Array.from({ length: 20 }, (_, i) => [0.1 + i * 0.01, 0.5]);
    expect(simplifyStroke(line, 0.001, m)).toEqual([line[0], line[19]]);
    const corner: DevelopPoint[] = [...line, [0.29, 0.6], [0.29, 0.7]];
    expect(simplifyStroke(corner, 0.001, m)).toEqual([line[0], line[19], [0.29, 0.7]]);
    const done = finishStroke(line, { size: 20, feather: 30, flow: 80, erase: true }, m);
    expect(done).toEqual({ points: [line[0], line[19]], size: 20, feather: 30, flow: 80, erase: true });
  });
});

describe('cropMapping', () => {
  it('is the identity frame without a crop', () => {
    const map = cropMapping(createDevelop().geometry, SIZE);
    expect(map.aspect).toBeCloseTo(1.5);
    expect(applyMat(map.toCrop, [0.25, 0.75])).toEqual([expect.closeTo(0.25), expect.closeTo(0.75)]);
  });

  it('maps the crop rect onto 0..1 and round-trips through a straightened crop', () => {
    const g = createDevelop().geometry;
    g.crop = { rect: { x: 0.2, y: 0.1, w: 0.5, h: 0.6 }, angle: 0, aspect: 'free' };
    const map = cropMapping(g, SIZE);
    expect(applyMat(map.toCrop, [0.2, 0.1])).toEqual([expect.closeTo(0), expect.closeTo(0)]);
    expect(applyMat(map.toCrop, [0.7, 0.7])).toEqual([expect.closeTo(1), expect.closeTo(1)]);
    g.crop = { rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, angle: 10, aspect: 'free' };
    const turned = cropMapping(g, SIZE);
    expect(turned.angle).toBe(10);
    // The crop centre stays put; other points turn about it.
    expect(applyMat(turned.toCrop, [0.5, 0.5])).toEqual([expect.closeTo(0.5), expect.closeTo(0.5)]);
    const p: DevelopPoint = [0.4, 0.45];
    const back = applyMat(turned.toFrame, applyMat(turned.toCrop, p));
    expect(back[0]).toBeCloseTo(p[0]);
    expect(back[1]).toBeCloseTo(p[1]);
  });

  it('swaps the frame for a quarter turn', () => {
    const g = createDevelop().geometry;
    g.rotate = 90;
    const map = cropMapping(g, SIZE);
    expect([map.fw, map.fh]).toEqual([800, 1200]);
  });
});

describe('approximateMask', () => {
  const map = cropMapping(createDevelop().geometry, SIZE);
  const at = (plane: Float32Array, gw: number, gh: number, u: number, v: number) =>
    plane[Math.min(Math.floor(v * gh), gh - 1) * gw + Math.min(Math.floor(u * gw), gw - 1)] ?? Number.NaN;

  it('draws a linear gradient 0 before from, 0.5 in the middle, 1 after to', () => {
    const plane = approximateMask(newMask('', newLinear([0.5, 0.2], [0.5, 0.8])), map, 60, 40);
    expect(plane).not.toBeNull();
    if (!plane) return;
    expect(at(plane, 60, 40, 0.5, 0.1)).toBe(0);
    expect(at(plane, 60, 40, 0.5, 0.5)).toBeCloseTo(0.5, 1);
    expect(at(plane, 60, 40, 0.5, 0.95)).toBe(1);
  });

  it('draws a radial gradient full inside and empty outside, and inverts', () => {
    const m = newMask('', newRadial([0.5, 0.5], [0.2, 0.2], undefined, 0, 50));
    const plane = approximateMask(m, map, 60, 40);
    if (!plane) throw new Error('no plane');
    expect(at(plane, 60, 40, 0.5, 0.5)).toBe(1);
    expect(at(plane, 60, 40, 0.05, 0.05)).toBe(0);
    const inverted = approximateMask({ ...m, invert: true, opacity: 50 }, map, 60, 40);
    if (!inverted) throw new Error('no plane');
    expect(at(inverted, 60, 40, 0.05, 0.05)).toBeCloseTo(0.5);
    expect(at(inverted, 60, 40, 0.5, 0.5)).toBe(0);
  });

  it('paints brush strokes with their flow, erases, and composites subtract and intersect', () => {
    const paint = newBrushComponent([
      {
        ...stroke([
          [0.2, 0.5],
          [0.8, 0.5],
        ]),
        flow: 60,
      },
    ]);
    const plane = approximateMask(newMask('', paint), map, 60, 40);
    if (!plane) throw new Error('no plane');
    expect(at(plane, 60, 40, 0.5, 0.5)).toBeCloseTo(0.6);
    expect(at(plane, 60, 40, 0.5, 0.1)).toBe(0);
    const erased = newBrushComponent([
      stroke([
        [0.2, 0.5],
        [0.8, 0.5],
      ]),
      stroke([[0.5, 0.5]], true),
    ]);
    const e = approximateMask(newMask('', erased), map, 60, 40);
    if (!e) throw new Error('no plane');
    expect(at(e, 60, 40, 0.5, 0.5)).toBe(0);
    expect(at(e, 60, 40, 0.25, 0.5)).toBe(1);
    const lin = newLinear([0, 0.5], [0.0001, 0.5]);
    const sub = approximateMask(
      { ...newMask('', lin), components: [lin, { ...newRadial([0.75, 0.5], [0.1, 0.1], 'subtract', 0, 0) }] },
      map,
      60,
      40,
    );
    if (!sub) throw new Error('no plane');
    expect(at(sub, 60, 40, 0.75, 0.5)).toBe(0);
    expect(at(sub, 60, 40, 0.3, 0.5)).toBe(1);
    const inter = approximateMask(
      { ...newMask('', lin), components: [lin, { ...newRadial([0.75, 0.5], [0.1, 0.1], 'intersect', 0, 0) }] },
      map,
      60,
      40,
    );
    if (!inter) throw new Error('no plane');
    expect(at(inter, 60, 40, 0.75, 0.5)).toBe(1);
    expect(at(inter, 60, 40, 0.3, 0.5)).toBe(0);
  });

  it('leaves range masks to the renderer', () => {
    expect(approximateMask(newMask('', newLuminance()), map, 10, 10)).toBeNull();
  });
});

describe('picking', () => {
  it('reads encoded luminance and hex', () => {
    expect(encodedLuminance(255, 255, 255)).toBeCloseTo(1);
    expect(encodedLuminance(0, 0, 0)).toBe(0);
    expect(encodedLuminance(128, 128, 128)).toBeCloseTo(128 / 255, 2);
    expect(toHex(255, 0, 16.4)).toBe('#ff0010');
    expect(rangeAround(0.05)).toEqual([0, 0.15]);
    expect(extendRange([0.4, 0.6], 0.8)).toEqual([0.4, 0.8]);
  });
});

describe('AI components', () => {
  const registry = [
    { name: 'birefnet-lite', version: '1', task: 'subject' },
    { name: 'birefnet-full', version: '1', task: 'subject' },
    { name: 'skywater-seg', version: '3', task: 'sky' },
    { name: 'rtdetr-v2', version: '1', task: 'people-detect' },
    { name: 'sam2.1-tiny-encoder', version: '2', task: 'sam-encoder' },
    { name: 'depth-anything-v2-small', version: '1', task: 'depth' },
  ];

  it('newAi leaves the model for the command to stamp; depth starts with a near range', () => {
    const sky = newAi('sky');
    expect(sky).toMatchObject({ kind: 'ai', target: 'sky', model: '', modelVersion: '', prompts: [], mode: 'add' });
    expect('depthRange' in sky).toBe(false);
    expect(newAi('depth', 'subtract')).toMatchObject({ depthRange: DEPTH_RANGE_DEFAULT, mode: 'subtract' });
    expect(DevelopMaskSchema.safeParse(newMask('M', newAi('depth'))).success).toBe(true);
  });

  it('stamps like stamp_model: the named model when it fits the task, else the task default; SAM when prompted', () => {
    expect(aiPrimaryTask(newAi('background'))).toBe('subject');
    expect(aiPrimaryTask(newAi('people'))).toBe('people-detect');
    expect(stampAi(newAi('sky'), registry)).toMatchObject({ model: 'skywater-seg', modelVersion: '3' });
    expect(stampAi({ ...newAi('subject'), model: 'birefnet-full' }, registry)?.model).toBe('birefnet-full');
    expect(stampAi({ ...newAi('subject'), model: 'skywater-seg' }, registry)?.model).toBe('birefnet-lite');
    const prompted = newAi('subject', 'add', [promptFrom([0.5, 0.5], null, true)]);
    expect(stampAi(prompted, registry)).toMatchObject({ model: 'sam2.1-tiny-encoder', modelVersion: '2' });
    // Sky never uses prompts.
    expect(aiPrimaryTask({ ...newAi('sky'), prompts: prompted.prompts })).toBe('sky');
    expect(stampAi(newAi('depth'), [])).toBeNull();
  });

  it('stamps Subject and Background with U2-Netp only when BiRefNet lite is missing and it is installed', () => {
    const installed = { state: 'installed' };
    const missing = { state: 'missing' };
    const models = (birefnet: { state: string }, fast: { state: string }) => [
      { name: 'birefnet-lite', version: '1', task: 'subject', status: birefnet },
      { name: 'u2netp', version: 'f', task: 'subject-fast', status: fast },
      { name: 'skywater-seg', version: '3', task: 'sky', status: missing },
    ];
    expect(stampAi(newAi('subject'), models(missing, missing))?.model).toBe('birefnet-lite');
    expect(stampAi(newAi('subject'), models(installed, installed))?.model).toBe('birefnet-lite');
    expect(stampAi(newAi('subject'), models(missing, installed))).toMatchObject({ model: 'u2netp', modelVersion: 'f' });
    expect(stampAi(newAi('background'), models(missing, installed))?.model).toBe('u2netp');
    expect(stampAi(newAi('sky'), models(missing, installed))?.model).toBe('skywater-seg');
    // Made with U2-Netp: outdated once BiRefNet lite is installed.
    const fast = stampAi(newAi('subject'), models(missing, installed));
    if (!fast) throw new Error('stamped expected');
    expect(isAiOutdated(fast, models(missing, installed))).toBe(false);
    expect(isAiOutdated(fast, models(installed, installed))).toBe(true);
  });

  it('is outdated when the registry has another version', () => {
    const made = stampAi(newAi('sky'), registry);
    if (!made) throw new Error('stamped expected');
    expect(isAiOutdated(made, registry)).toBe(false);
    expect(isAiOutdated({ ...made, modelVersion: '2' }, registry)).toBe(true);
    expect(isAiOutdated(made, [])).toBe(false);
  });

  it('turns a press into a point or a sorted box', () => {
    expect(promptFrom([0.2, 0.3], null, false)).toEqual({ kind: 'point', point: [0.2, 0.3], positive: false });
    expect(promptFrom([0.6, 0.7], [0.2, 0.1], true)).toEqual({
      kind: 'box',
      box: [
        [0.2, 0.1],
        [0.6, 0.7],
      ],
      positive: true,
    });
  });

  it('labels targets and per-person components', () => {
    const box = (x: number) => promptFrom([x, 0], [x + 0.1, 1], true);
    const p1 = newAi('people', 'add', [box(0)]);
    const p2 = newAi('people', 'add', [box(0.5)]);
    const all = newAi('people');
    const m = { ...newMask('People', p1), components: [p1, all, p2] };
    expect(componentLabel(p2, m)).toBe('Person 2');
    expect(componentLabel(all, m)).toBe('People');
    expect(componentLabel(newAi('depth'))).toBe('Depth range');
    expect(componentLabel(newLinear([0, 0], [1, 1]))).toBe('Linear gradient');
  });
});
