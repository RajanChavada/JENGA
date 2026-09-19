'use client';

import { Suspense, useEffect, useMemo, useRef, useState, type ElementRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Billboard, CameraControls, Text } from '@react-three/drei';
import { Vector3, type Mesh, type MeshStandardMaterial, type PerspectiveCamera } from 'three';
import {
  DENIED_STYLE,
  STATE_STYLE,
  ZONE_BOXES,
  ZONE_LABEL,
  deniedTaskIds,
  zoneProgress,
  zoneVisual,
} from '@/lib/theme';
import { useJenga } from '@/store/useJenga';
import { focusedZone, framePose } from '@/lib/focus';
import type { Task, Zone } from '@/lib/types';

/** Where the camera rests when nothing is focused. */
const HOME_POSITION: [number, number, number] = [22, 17, 22];

const MIN_DISTANCE = 8;
const MAX_DISTANCE = 40;

/** Other zones fade to this share of their normal opacity while one is focused. */
const DIMMED_OPACITY = 0.15;

/** Each label parked outside the footprint on a distinct side so none overlap. */
const LABEL_OFFSET: Record<Zone, [number, number, number]> = {
  track_bed: [-8.4, 0.9, 0],
  south_platform: [0, 1.9, 5.4],
  north_platform: [0, 1.9, -5.4],
  mezzanine: [0, 5.6, 0],
  escalator_well: [7.4, 4.2, 1.6],
};

function ZoneMesh({
  zone,
  tasks,
  denied,
  selected,
  dimmed,
  onSelect,
}: {
  zone: Zone;
  tasks: Task[];
  denied: Set<string>;
  selected: boolean;
  /** Another zone is focused: fade this one so the focused zone is never hidden behind it. */
  dimmed: boolean;
  onSelect: () => void;
}) {
  const box = ZONE_BOXES[zone];
  const state = zoneVisual(tasks, denied);
  const style = state === 'denied' ? DENIED_STYLE : STATE_STYLE[state];
  const progress = zoneProgress(tasks);
  const ref = useRef<Mesh>(null);

  // under_review pulses, matching the amber pulse on the 2D node, and a denial
  // pulses red. Same state, same read, two projections.
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const mat = ref.current.material as MeshStandardMaterial;
    // Ease toward the target rather than snapping, so the fade reads as part of
    // the camera move. `style.opacity` is also the prop below, so a state change
    // still lands instantly and this only ever adds the dimming on top.
    const target = style.opacity * (dimmed ? DIMMED_OPACITY : 1);
    mat.opacity += (target - mat.opacity) * 0.2;
    if (style.pulse) {
      mat.emissiveIntensity = 0.4 + 0.35 * Math.sin(clock.elapsedTime * 3);
    } else {
      mat.emissiveIntensity = selected ? 0.5 : 0.12;
    }
  });

  return (
    <group position={box.position}>
      <mesh
        ref={ref}
        onClick={(e) => {
          // A hit is not a miss: keep Canvas.onPointerMissed (clear focus) out of it.
          e.stopPropagation();
          onSelect();
        }}
      >
        <boxGeometry args={box.size} />
        <meshStandardMaterial
          color={style.hex}
          emissive={style.hex}
          emissiveIntensity={0.12}
          wireframe={style.wireframe}
          transparent
          opacity={style.opacity}
        />
      </mesh>
      {/*
        Labels sit outside the model on their own side rather than directly above
        each box: mezzanine (y 4.85) and escalator_well (y 4.65) are almost level,
        so top-anchored labels collide at most camera angles. Billboard keeps them
        readable as the scene orbits.
      */}
      <Billboard position={LABEL_OFFSET[zone]} visible={!dimmed}>
        <Text
          fontSize={0.42}
          color={selected ? '#0f172a' : '#475569'}
          anchorX="center"
          outlineWidth={0.02}
          outlineColor="#ffffff"
        >
          {progress ? `${ZONE_LABEL[zone]} · ${progress}` : ZONE_LABEL[zone]}
        </Text>
      </Billboard>
    </group>
  );
}

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Drives the camera from the focus. A focused zone is framed along the angle the
 * user has orbited to (see `framePose`); clearing the focus returns to the home pose. The first run after a
 * (re)mount is instant: nothing should animate on load, and a WebGL-context
 * remount must land straight back on the focused zone.
 */
function CameraRig({ zone }: { zone: Zone | null }) {
  const controls = useRef<ElementRef<typeof CameraControls>>(null);
  const first = useRef(true);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const animate = !first.current && !reducedMotion();
    if (zone) {
      // Look at the zone from wherever the user is already looking. `fitToBox`
      // would frame it too, but it snaps the camera to the nearest axis.
      const here = c.getPosition(new Vector3(), true);
      const target = c.getTarget(new Vector3(), true);
      const pose = framePose(
        [here.x, here.y, here.z],
        [target.x, target.y, target.z],
        ZONE_BOXES[zone],
        (c.camera as PerspectiveCamera).fov,
        { min: MIN_DISTANCE, max: MAX_DISTANCE },
      );
      void c.setLookAt(...pose.position, ...pose.target, animate);
    } else if (!first.current) {
      void c.setLookAt(...HOME_POSITION, 0, 0, 0, animate);
    }
    first.current = false;
  }, [zone]);

  return (
    <CameraControls
      ref={controls}
      minDistance={MIN_DISTANCE}
      maxDistance={MAX_DISTANCE}
      smoothTime={0.3}
      // camera-controls ACTION values: 0 none, 1 rotate, 16 dolly; touch 64 rotate,
      // 1024 dolly. Pan (truck) stays off, as it was under OrbitControls.
      mouseButtons={{ left: 1, middle: 0, right: 0, wheel: 16 }}
      touches={{ one: 64, two: 1024, three: 0 }}
    />
  );
}

export function StationView() {
  const tasks = useJenga((s) => s.tasks);
  const selectedTaskId = useJenga((s) => s.selectedTaskId);
  const selectedZone = useJenga((s) => s.selectedZone);
  const selectZone = useJenga((s) => s.selectZone);
  const clearFocus = useJenga((s) => s.clearFocus);
  // The zone the focus points at: the selected task's zone, or the selected zone.
  const focused = useMemo(
    () => focusedZone(selectedTaskId, selectedZone, tasks),
    [selectedTaskId, selectedZone, tasks],
  );
  const reports = useJenga((s) => s.reports);
  const denied = useMemo(() => deniedTaskIds(tasks, reports), [tasks, reports]);
  // WebGL contexts get evicted by the browser under pressure (and by dev-server
  // reload churn), leaving a correctly-sized but permanently blank canvas.
  // Bumping this key remounts the <Canvas>, which creates a fresh context —
  // the twin heals itself instead of sitting white until a tab switch.
  const [glGeneration, setGlGeneration] = useState(0);

  const byZone = useMemo(() => {
    const m = {} as Record<Zone, Task[]>;
    (Object.keys(ZONE_BOXES) as Zone[]).forEach((z) => {
      m[z] = tasks.filter((t) => t.zone === z);
    });
    return m;
  }, [tasks]);

  return (
    <div className="relative h-full w-full bg-slate-50">
      <div className="pointer-events-none absolute left-3 top-3 z-10 text-[10px] uppercase tracking-wider text-slate-400">
        Digital twin · click a zone to select its work
      </div>
      {/* Zones span ~14 units; pull back far enough to frame the whole station. */}
      <Canvas
        key={glGeneration}
        camera={{ position: HOME_POSITION, fov: 40 }}
        // A click on empty space (not a drag) clears the focus.
        onPointerMissed={() => clearFocus()}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            setGlGeneration((g) => g + 1);
          });
        }}
      >
        <ambientLight intensity={0.75} />
        <directionalLight position={[10, 14, 8]} intensity={0.9} />
        <gridHelper args={[30, 30, '#cbd5e1', '#e2e8f0']} position={[0, -0.6, 0]} />
        {/*
          drei's <Text> suspends while its font loads. Without a boundary that
          suspension unmounts the whole scene and the canvas renders empty, so the
          zone meshes need to sit inside Suspense rather than beside it.
        */}
        <Suspense fallback={null}>
          {(Object.keys(ZONE_BOXES) as Zone[]).map((z) => (
            <ZoneMesh
              key={z}
              zone={z}
              tasks={byZone[z]}
              denied={denied}
              selected={focused === z}
              dimmed={focused !== null && focused !== z}
              onSelect={() => selectZone(selectedZone === z ? null : z, 'twin')}
            />
          ))}
        </Suspense>
        <CameraRig zone={focused} />
      </Canvas>
    </div>
  );
}
