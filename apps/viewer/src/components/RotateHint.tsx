import type { Manifest } from '@photobook/shared';
import { useEffect, useState } from 'preact/hooks';
import { markRotateHintShown, rotateHintShown } from '../storage';

const SHOW_MS = 4000;

/** Landscape book on a portrait screen: the page letterboxes and this toast shows once per session. */
export function RotateHint({ template }: { template: Manifest['template'] }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (template.width <= template.height || rotateHintShown()) return;
    const portrait = window.matchMedia('(orientation: portrait)');
    if (!portrait.matches) return;
    setShow(true);
    markRotateHintShown();
    const timer = setTimeout(() => setShow(false), SHOW_MS);
    const onChange = () => {
      if (!portrait.matches) setShow(false);
    };
    portrait.addEventListener('change', onChange);
    return () => {
      clearTimeout(timer);
      portrait.removeEventListener('change', onChange);
    };
  }, [template]);

  return show ? (
    <div class="pv-toast" role="status">
      Rotate your phone for a bigger page
    </div>
  ) : null;
}
