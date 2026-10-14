import { type ReactNode, useState } from 'react';
import { mixTrack } from '../develop/DevelopPanel';
import { PanelCard } from '../develop/PanelCard';
import { RenderDot } from '../develop/renderProgress';
import { Slider } from '../develop/Slider';
import { TEMPERATURE_TRACK, TINT_TRACK } from '../develop/WhiteBalanceControls';
import { CloseIcon, MoreIcon, PlusIcon, RedoIcon, UndoIcon } from '../editor/icons';
import { Button, type ButtonVariant, IconButton } from '../ui/Button';
import { CountUp } from '../ui/CountUp';
import { DialogBody, DialogButton, DialogFooter, DialogShell } from '../ui/DialogShell';
import { EmptyState } from '../ui/EmptyState';
import { Checkbox, Field, Input, NumberInput, Select, Switch } from '../ui/Field';
import { Menu, MenuItem, MenuLabel, MenuSeparator, useContextMenu } from '../ui/Menu';
import { PopoverButton } from '../ui/Popover';
import { ProgressRing } from '../ui/ProgressRing';
import { Segmented } from '../ui/Segmented';
import { Tag } from '../ui/Tag';
import { Toast, toast } from '../ui/Toast';
import { Tooltip } from '../ui/Tooltip';
import { DevelopSink } from './DevelopSink';
import { GradingSink } from './GradingSink';

/**
 * Plan 45: every primitive of `components/ui` in every state, for review screenshots. Nothing here calls Tauri; the
 * controls hold their own state.
 */

const VARIANTS: ButtonVariant[] = ['primary', 'soft', 'ghost', 'danger', 'toggle'];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-28 shrink-0 font-mono text-[11px] text-fg-muted">{label}</span>
      {children}
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3" data-testid={`primitive-${title}`}>
      <h2 className="section-title">{title}</h2>
      <div className="flex flex-col gap-3 rounded-md bg-panel p-4">{children}</div>
    </section>
  );
}

export function PrimitivesSink() {
  const [toggled, setToggled] = useState(true);
  const [segment, setSegment] = useState<'fit' | '1' | '2' | '4'>('fit');
  const [stage, setStage] = useState<'cull' | 'develop' | 'design'>('develop');
  const [text, setText] = useState('Lisbon 2026');
  const [amount, setAmount] = useState(0.35);
  const [width, setWidth] = useState(2048);
  const [format, setFormat] = useState('jpeg');
  const [checked, setChecked] = useState(true);
  const [on, setOn] = useState(true);
  const [grid, setGrid] = useState(true);
  const [snap, setSnap] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [progress, setProgress] = useState(0.4);
  const [replay, setReplay] = useState(0);
  const context = useContextMenu();

  return (
    <div className="flex flex-col gap-8">
      <Block title="Button">
        {(['md', 'sm'] as const).map((size) => (
          <Row key={size} label={`size ${size}`}>
            {VARIANTS.map((v) => (
              <Button
                key={v}
                variant={v}
                size={size}
                pressed={v === 'toggle' ? toggled : undefined}
                onClick={v === 'toggle' ? () => setToggled((t) => !t) : undefined}
              >
                {v === 'toggle' ? `Toggle ${toggled ? 'on' : 'off'}` : v[0]?.toUpperCase() + v.slice(1)}
              </Button>
            ))}
          </Row>
        ))}
        <Row label="disabled">
          {VARIANTS.map((v) => (
            <Button key={v} variant={v} disabled>
              {v[0]?.toUpperCase() + v.slice(1)}
            </Button>
          ))}
        </Row>
        <Row label="icon">
          <Button icon={<PlusIcon />}>Add 12 to project</Button>
          <Button variant="primary" icon={<PlusIcon />}>
            New project…
          </Button>
          <IconButton icon={<UndoIcon />} label="Undo" shortcut="⌘Z" />
          <IconButton icon={<RedoIcon />} label="Redo" shortcut="⇧⌘Z" disabled />
          <IconButton icon={<CloseIcon />} label="Close" size="sm" />
          <IconButton icon={<MoreIcon />} label="More" variant="soft" />
        </Row>
      </Block>

      <Block title="Segmented">
        <Row label="stages">
          <Segmented
            label="Stage"
            items={[
              { value: 'cull', label: 'Cull' },
              { value: 'develop', label: 'Develop' },
              { value: 'design', label: 'Design' },
            ]}
            value={stage}
            onChange={setStage}
          />
        </Row>
        <Row label="zoom">
          <Segmented
            label="Zoom"
            items={[
              { value: 'fit', label: 'Fit' },
              { value: '1', label: '1×' },
              { value: '2', label: '2×' },
              { value: '4', label: '4×', disabled: true, title: 'Not at this size' },
            ]}
            value={segment}
            onChange={setSegment}
          />
        </Row>
      </Block>

      <Block title="Fields">
        <div className="grid max-w-2xl grid-cols-3 gap-4">
          <Field label="Title" hint="Shown on the cover">
            <Input value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <Field label="Placeholder">
            <Input placeholder="Search photos" />
          </Field>
          <Field label="Disabled">
            <Input value="Read only" disabled readOnly />
          </Field>
          <Field label="Amount" hint="Option + wheel nudges; Shift × 10">
            <NumberInput value={amount} onChange={setAmount} step={0.05} min={-5} max={5} unit="EV" />
          </Field>
          <Field label="Long edge">
            <NumberInput value={width} onChange={setWidth} step={1} min={64} max={16000} unit="px" />
          </Field>
          <Field label="Format" error={format === 'tiff' ? 'TIFF exports come later' : undefined}>
            <Select value={format} onChange={(e) => setFormat(e.target.value)}>
              <option value="jpeg">JPEG</option>
              <option value="webp">WebP</option>
              <option value="tiff">TIFF</option>
            </Select>
          </Field>
        </div>
        <Row label="checkbox">
          <Checkbox checked={checked} onChange={setChecked} label="Replace existing files" />
          <Checkbox checked={!checked} onChange={(v) => setChecked(!v)} label="Off" hint="With a second line" />
          <Checkbox checked disabled onChange={() => {}} label="Disabled" />
        </Row>
        <Row label="switch">
          <Switch checked={on} onChange={setOn} label="Haptics" className="w-40" />
          <Switch checked={!on} onChange={(v) => setOn(!v)} label="Off" className="w-40" />
          <Switch checked disabled onChange={() => {}} label="Disabled" className="w-40" />
        </Row>
      </Block>

      <Block title="Menu">
        <Row label="menu button">
          <Menu
            label={
              <>
                Project <span aria-hidden="true">▾</span>
              </>
            }
            menuLabel="Project (sink)"
          >
            <MenuLabel>Lisbon 2026</MenuLabel>
            <MenuItem>Rename…</MenuItem>
            <MenuItem shortcut="⇧⌘S">Save as…</MenuItem>
            <MenuItem disabled title="Nothing to preview">
              Preview
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger>Close project</MenuItem>
          </Menu>
          <Menu
            label={
              <>
                View <span aria-hidden="true">▾</span>
              </>
            }
            menuLabel="View (sink)"
            width={260}
          >
            <MenuItem checked={grid} onSelect={() => setGrid((g) => !g)}>
              Show grid
            </MenuItem>
            <MenuItem checked={snap} hint="Hold Cmd while dragging to skip" onSelect={() => setSnap((s) => !s)}>
              Snap to guides
            </MenuItem>
          </Menu>
        </Row>
        <Row label="context">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the right-click target of the demo */}
          <div
            onContextMenu={(e) => context.onContextMenu(e, undefined)}
            className="flex h-16 w-64 items-center justify-center rounded-md border border-hairline border-dashed text-fg-muted text-xs"
          >
            Right-click here (Menu.Context)
          </div>
          <div
            data-native-menu
            className="flex h-16 w-64 items-center justify-center rounded-md border border-hairline border-dashed text-fg-muted text-xs"
          >
            data-native-menu: the system's
          </div>
          <Menu.Context at={context.at} label="Photo (sink)" onClose={context.close}>
            <MenuItem>Make a version</MenuItem>
            <MenuSeparator />
            <MenuItem shortcut="⇧⌘C">Copy settings</MenuItem>
            <MenuItem shortcut="⇧⌘V" disabled>
              Paste settings
            </MenuItem>
          </Menu.Context>
        </Row>
      </Block>

      <Block title="Popover and tooltip">
        <Row label="popover">
          <PopoverButton label="Save as collection…" variant="soft" panelLabel="Save as collection (sink)">
            {(close) => (
              <div className="flex flex-col gap-2">
                <Field label="Collection name">
                  <Input defaultValue="Picks, 3★ and up" />
                </Field>
                <Button variant="primary" size="sm" className="self-end" onClick={close}>
                  Save
                </Button>
              </div>
            )}
          </PopoverButton>
        </Row>
        <Row label="tooltip">
          <Tooltip label="Before / after" shortcut="\">
            <Button variant="toggle">Before/After</Button>
          </Tooltip>
          <span className="text-[11px] text-fg-muted">600 ms on hover, at once on keyboard focus</span>
        </Row>
      </Block>

      <Block title="Toast">
        <div className="flex max-w-md flex-col gap-1.5">
          <Toast onDismiss={() => {}} actions={[{ label: 'Undo', run: () => {} }]}>
            This page is now custom.
          </Toast>
          <Toast progress={progress} onDismiss={() => {}}>
            Exporting with Web JPEG… 23/58
          </Toast>
          <Toast progress="busy">Making trip.mp4 of “Trip”…</Toast>
          <Toast done actions={[{ label: 'Reveal in Finder', run: () => {} }]} onDismiss={() => {}}>
            Exported 58 photos with Web JPEG.
          </Toast>
          <Toast tone="danger" onDismiss={() => {}}>
            zine.pdf of “Zine” failed: disk full
          </Toast>
        </div>
        <Row label="host">
          <Button
            size="sm"
            onClick={() => toast.show({ text: 'Saved to the Desktop.', actions: [{ label: 'Undo', run: () => {} }] })}
          >
            Show a toast
          </Button>
          <span className="text-[11px] text-fg-muted">The host is bottom-left, mounted once in main.tsx</span>
        </Row>
      </Block>

      <DelightBlock />

      <Block title="Tag, ring, count">
        <Row label="tag">
          <Tag>jpeg</Tag>
          <Tag>v2</Tag>
          <Tag tone="accent">Edited</Tag>
          <Tag tone="ok">In the book</Tag>
          <Tag tone="warn">ISO 6400</Tag>
          <Tag tone="danger">Missing</Tag>
        </Row>
        <Row label="progress ring">
          <ProgressRing value={0} label="Zero" />
          <ProgressRing value={progress} label="Some" />
          <ProgressRing label="Busy" />
          <ProgressRing done label="Done" />
          <ProgressRing value={progress} size={24} />
          <Button size="sm" onClick={() => setProgress((p) => (p >= 1 ? 0 : Math.min(1, p + 0.2)))}>
            Step
          </Button>
        </Row>
        <Row label="count up">
          <CountUp key={replay} value={1284} className="text-fg" />
          <CountUp key={`b${replay}`} value={58} className="text-fg-muted" />
          <Button size="sm" onClick={() => setReplay((r) => r + 1)}>
            Replay
          </Button>
        </Row>
      </Block>

      <Block title="Slider">
        <SliderSink />
      </Block>

      <Block title="Grading wheels">
        <GradingSink />
      </Block>

      <Block title="Develop cards">
        <DevelopSink />
      </Block>

      <Block title="DialogShell">
        <Row label="dialog">
          <Button onClick={() => setDialog(true)}>Open a dialog</Button>
        </Row>
        {dialog && (
          <DialogShell title="Sync settings" onClose={() => setDialog(false)}>
            <DialogBody>
              <p className="m-0 text-fg-2">Copy the White balance and Light of this photo to 12 others.</p>
              <Checkbox checked={checked} onChange={setChecked} label="White balance" />
            </DialogBody>
            <DialogFooter note="12 photos">
              <DialogButton variant="ghost" onClick={() => setDialog(false)}>
                Cancel
              </DialogButton>
              <DialogButton primary onClick={() => setDialog(false)}>
                Sync 12 photos
              </DialogButton>
            </DialogFooter>
          </DialogShell>
        )}
      </Block>
    </div>
  );
}

/**
 * Plan 46: the Develop slider in a card, as in the panel: a plain track with its fill, an edited row, the gradient
 * tracks (temperature, tint, a hue band) where the needle must stay readable, and a disabled row. Hover a row for the
 * ticks; drag through the default for the detent.
 */
function SliderSink() {
  const [values, setValues] = useState({ exposure: 0.45, contrast: 0, temp: 18, tint: -6, hue: 12, sat: -40 });
  const [open, setOpen] = useState(true);
  const set = (key: keyof typeof values) => (v: number) => setValues((o) => ({ ...o, [key]: v }));
  return (
    <div className="flex flex-wrap items-start gap-6">
      <div className="w-80 rounded-md bg-panel p-2" data-testid="slider-sink">
        <PanelCard
          title="Light"
          open={open}
          onToggle={() => setOpen((o) => !o)}
          meta={<RenderDot className="ml-1" label="Rendering (sample)" />}
          onReset={() => setValues((o) => ({ ...o, exposure: 0, contrast: 0 }))}
          resetDisabled={values.exposure === 0 && values.contrast === 0}
        >
          <Slider label="Exposure" value={values.exposure} min={-5} max={5} step={0.01} onChange={set('exposure')} />
          <Slider label="Contrast" value={values.contrast} min={-100} max={100} onChange={set('contrast')} />
          <Slider
            label="Temperature"
            value={values.temp}
            min={-100}
            max={100}
            track={TEMPERATURE_TRACK}
            onChange={set('temp')}
          />
          <Slider label="Tint" value={values.tint} min={-100} max={100} track={TINT_TRACK} onChange={set('tint')} />
          <Slider
            label="Red hue"
            swatch="hsl(0 80% 55%)"
            value={values.hue}
            min={-100}
            max={100}
            track={mixTrack('red', 'hue')}
            onChange={set('hue')}
          />
          <Slider
            label="Blue saturation"
            swatch="hsl(230 80% 55%)"
            value={values.sat}
            min={-100}
            max={100}
            track={mixTrack('blue', 'saturation')}
            onChange={set('sat')}
          />
          <Slider label="Amount" value={60} min={0} max={100} onChange={() => {}} disabled />
        </PanelCard>
      </div>
    </div>
  );
}

/**
 * Plan 49: the delight pass's pieces in one place (ODDHALLS_UI_PLAN 4.4, ODDHALLS_LAYOUT_PLAN 6): a job's completion
 * beat in the real toast host (ring, the check's 160 ms stroke, the 400 ms hold, then what landed), the check alone,
 * an empty state, the loupe's sweep and the tools' cursors. Every one is timed by the tokens, so reduced motion shows
 * the end state at once. No `invoke`.
 */
function DelightBlock() {
  const [check, setCheck] = useState(0);
  const [sweep, setSweep] = useState(0);
  const runJob = () => {
    const id = toast.show({ text: 'Exporting with Web JPEG… 0/3', progress: 0, durationMs: null });
    for (const n of [1, 2, 3]) {
      setTimeout(() => {
        if (n < 3) toast.update(id, { text: `Exporting with Web JPEG… ${n}/3`, progress: n / 3 });
        else
          toast.update(id, {
            text: 'Exported 3 photos with Web JPEG.',
            progress: undefined,
            done: true,
            actions: [{ label: 'Reveal in Finder', run: () => {} }],
          });
      }, n * 500);
    }
  };
  return (
    <Block title="Delight">
      <Row label="job beat">
        <Button size="sm" onClick={runJob}>
          Run a job
        </Button>
        <span className="text-[11px] text-fg-muted">The ring completes, the check holds 400 ms, then the result</span>
      </Row>
      <Row label="check">
        <ProgressRing key={check} done label="Done" size={24} />
        <Button size="sm" onClick={() => setCheck((c) => c + 1)}>
          Draw again
        </Button>
      </Row>
      <Row label="empty state">
        <EmptyState size="md" className="items-start text-left" action={<Button size="sm">Open a folder…</Button>}>
          No photos in this folder
        </EmptyState>
      </Row>
      <Row label="loupe sweep">
        <span className="relative block h-16 w-40 overflow-hidden rounded-sm bg-panel-3">
          <span className="absolute inset-0 grid place-items-center text-[11px] text-fg">clean</span>
          <span key={sweep} aria-hidden="true" className="pointer-events-none absolute inset-0">
            <span className="loupe-sweep dot-grid absolute inset-0 grid place-items-center text-[11px] text-fg-muted">
              noisy
            </span>
            <span className="loupe-sweep-line absolute top-0 bottom-0 w-px bg-fg/90" />
          </span>
        </span>
        <Button size="sm" onClick={() => setSweep((s) => s + 1)}>
          Sweep
        </Button>
      </Row>
      <Row label="cursors">
        {(['cursor-draw', 'cursor-rotate', 'cursor-pan', 'cursor-panning'] as const).map((c) => (
          <span
            key={c}
            className={`${c} grid h-10 w-20 place-items-center rounded-sm bg-panel-2 font-mono text-[10px] text-fg-muted`}
          >
            {c.slice(7)}
          </span>
        ))}
      </Row>
    </Block>
  );
}
