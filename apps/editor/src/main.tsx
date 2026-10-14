import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Workflow plan 34: the caption brief dialog (opened by ✦ Write and the Project menu).
import { BriefDialogHost } from './components/ai/BriefDialog';
// Workflow plan 35: Caption book… (Design → Book menu) and Caption this page (page strip menu, page inspector).
import { CaptionBookDialogHost } from './components/ai/CaptionBookDialog';
import { CaptionPageSheetHost } from './components/ai/CaptionPageSheet';
// Workflow plan 33: Describe photos (the photo index): its dialog, and its batch bar slot registered on import.
import { DescribeDialog } from './components/ai/DescribePhotos';
// Workflow plan 14: social post export toasts.
import { PostExportToast } from './components/design/PostExportToast';
import { PrintExportToast } from './components/design/PrintExportToast';
// Workflow plan 16: slideshow video toasts.
import { SlideshowExportToast } from './components/design/SlideshowExportToast';
// Workflow plan 27: Denoise selected (its confirm, and its batch bar slot registered on import).
import { DenoiseBatchDialog } from './components/develop/DenoiseBatch';
import { ExportDialog } from './components/export/ExportDialog';
import { ExportToast } from './components/export/ExportToast';
import { installExportShortcut } from './components/export/entryPoints';
import { JobsBar } from './components/shell/JobsBar';
// Plan 45: the one toast host (bottom-left); the export toasts are its feeds, `toast.show` adds the rest.
import { ToastHost } from './components/ui/Toast';
import { installProjectJobCancel } from './lib/jobs/projectClose';
import { installErrorForwarding } from './lib/log';
import { installNativeMenuBar } from './lib/nativeMenu';
import { nativeMenuActions } from './lib/nativeMenuActions';
import { installNativeGuards } from './lib/nativeShell';
import { installSurround } from './lib/surround';
import { router } from './router';
import { installCloseFlush, startAutosave, startLibraryAutosave } from './store/autosave';
import './styles.css';

installErrorForwarding();
// Plan 43: no browser context menu, no native drag, no reload key in release builds.
installNativeGuards({ release: !import.meta.env.DEV });
// Plan 43: the native menu bar owns the accelerators only with VITE_PHOTOBOOK_NATIVE_MENU=1; without it the keydown
// handlers own every key, as before. The flag stays until the owner has checked that no key fires twice (plan 49's
// Status line lists the removal steps).
if (import.meta.env.VITE_PHOTOBOOK_NATIVE_MENU === '1') void installNativeMenuBar(nativeMenuActions);
startAutosave();
startLibraryAutosave();
void installCloseFlush();
installProjectJobCancel();
// Workflow plan 11: Cmd+Shift+E and the Export dialog (also opened from Develop, Cull and the sidebar).
installExportShortcut();
// Plan 44: Settings → Appearance → Surround sets `--color-stage` on `:root`.
installSurround();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
    <JobsBar />
    <ExportDialog />
    <ToastHost>
      <ExportToast />
      <PostExportToast />
      <PrintExportToast />
      <SlideshowExportToast />
    </ToastHost>
    <DescribeDialog />
    <DenoiseBatchDialog />
    <CaptionPageSheetHost />
    <CaptionBookDialogHost />
    <BriefDialogHost />
  </StrictMode>,
);

// Workflow plan 36: the platform-budgets bench (`lib/bench/budgets.ts`), only on a dev server started with
// VITE_PHOTOBOOK_BENCH=1 (`scripts/measure/README.md`).
if (import.meta.env.DEV && import.meta.env.VITE_PHOTOBOOK_BENCH === '1') {
  void import('./lib/bench/budgets').then((m) => m.runBudgetsBench());
}
