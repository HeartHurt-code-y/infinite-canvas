import React from "react";
import { Composition, registerRoot } from "remotion";
import { Animation, type AnimationPlan } from "./Composition";
import { EXAMPLE_PLAN } from "./plan.mjs";

const Root = () => (
  <Composition
    id="Animation"
    component={Animation}
    defaultProps={{ plan: EXAMPLE_PLAN as AnimationPlan }}
    durationInFrames={180}
    fps={30}
    width={800}
    height={600}
    calculateMetadata={({ props }) => ({
      durationInFrames: props.plan.durationInFrames,
      fps: props.plan.fps,
      width: props.plan.width,
      height: props.plan.height,
    })}
  />
);
registerRoot(Root);
