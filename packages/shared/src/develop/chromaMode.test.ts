import { describe, expect, it } from 'vitest';
import { createDevelop, DenoiseSchema, developHashInput } from './schema.js';

// Workflow plan 24: `detail.denoise.chromaMode` defaults to `filter` and the hash leaves it out at that default.
describe('denoise chromaMode', () => {
  it('defaults to filter', () => {
    expect(DenoiseSchema.parse({ model: 'nafnet-w32' }).chromaMode).toBe('filter');
  });

  it('changes no hash at its default, and model does', () => {
    const without = createDevelop();
    without.detail.denoise = DenoiseSchema.parse({ model: 'nafnet-w32', luminance: 40 });
    const legacy = developHashInput({
      ...without,
      detail: { ...without.detail, denoise: { model: 'nafnet-w32', luminance: 40, chroma: 75, sharpen: 25 } },
    } as never);
    expect(developHashInput(without)).toBe(legacy);
    expect(developHashInput(without)).not.toContain('chromaMode');
    const model = structuredClone(without);
    if (model.detail.denoise) model.detail.denoise.chromaMode = 'model';
    expect(developHashInput(model)).toContain('"chromaMode":"model"');
  });
});
