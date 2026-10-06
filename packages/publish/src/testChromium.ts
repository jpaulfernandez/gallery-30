import { chromium } from 'playwright';
import { CHROMIUM_INSTALL_COMMAND } from './pages.js';

/**
 * Test helper: whether Playwright's Chromium can start here. Page-image tests skip without it
 * (with a note) instead of failing; the publish step itself warns and skips in that case.
 */
export const hasChromium: boolean = await chromium.launch().then(
  async (browser) => {
    await browser.close();
    return true;
  },
  () => false,
);

if (!hasChromium) {
  console.warn(
    `Chromium for Playwright is not installed: page image tests are skipped. Run: ${CHROMIUM_INSTALL_COMMAND}`,
  );
}
