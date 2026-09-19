'use client';

import { Suspense, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Billboard, OrbitControls, Text } from '@react-three/drei';
import type { Mesh, MeshStandardMaterial } from 'three';
import { ZONE_BOXES, ZONE_LABEL, STATE_STYLE, aggregateZoneState } from '@/lib/theme';
import { useJenga } from '@/store/useJenga';
import type { Task, Zone } from '@/lib/types';

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
  selected,
  onSelect,
}: {
  zone: Zone;
  tasks: Task[];
  selected: boolean;
  onSelect: () => void;
}) {
  const box = ZONE_BOXES[zone];
  const state = aggregateZoneState(tasks.map((t) => t.state));
  const style = STATE_STYLE[state];
  const ref = useRef<Mesh>(null);

  // under_review pulses, matching the amber pulse on the 2D node. Same state,
  // same read, two projections.
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const mat = ref.current.material as MeshStandardMaterial;
    if (state === 'under_review') {
      mat.emissiveIntensity = 0.4 + 0.35 * Math.sin(clock.elapsedTime * 3);
    } else {
      mat.emissiveIntensity = selected ? 0.5 : 0.12;
    }
  });

  return (
    <group position={box.position}>
      <mesh ref={ref} onClick={onSelect}>
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
      <Billboard position={LABEL_OFFSET[zone]}>
        <Text
          fontSize={0.42}
          color={selected ? '#0f172a' : '#475569'}
          anchorX="center"
          outlineWidth={0.02}
          outlineColor="#ffffff"
        >
          {ZONE_LABEL[zone]}
        </Text>
      </Billboard>
    </group>
  );
}

export function StationView() {
  const tasks = useJenga((s) => s.tasks);
  const selectedZone = useJenga((s) => s.selectedZone);
  const selectZone = useJenga((s) => s.selectZone);

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
      <Canvas camera={{ position: [22, 17, 22], fov: 40 }}>
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
              selected={selectedZone === z}
              onSelect={() => selectZone(selectedZone === z ? null : z)}
            />
          ))}
        </Suspense>
        <OrbitControls enablePan={false} minDistance={8} maxDistance={40} />
      </Canvas>
    </div>
  );
}
