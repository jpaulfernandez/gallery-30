// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Tag } from './Tag';

afterEach(cleanup);

describe('Tag', () => {
  it('uses the tag utility (10 px mono uppercase) and colours its label by tone', () => {
    render(
      <>
        <Tag>v2</Tag>
        <Tag tone="danger" title="Not on disk">
          Missing
        </Tag>
      </>,
    );
    expect(screen.getByText('v2').className).toMatch(/^tag /);
    const missing = screen.getByText('Missing');
    expect(missing.className).toContain('text-danger');
    expect(missing.getAttribute('title')).toBe('Not on disk');
  });
});
