"""What a new account starts with: a generic exercise list and an empty Profile template.
No plan ships; the athlete (or the assistant) writes workouts with the normal ops.

Installed through the change seam as one hidden `system` change, and only into an account
that has neither exercises nor a Profile yet, so it never overwrites anything.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import Exercise
from plan.changes import ChangeResult, apply_change, current_profile

# (id, name, type, default_measure, cues)
EXERCISES: list[tuple[str, str, str, str, str]] = [
    # running
    ("easy-run", "Easy run", "run", "distance", "Conversational pace; you could speak in full sentences."),
    ("long-run", "Long run", "run", "distance", "Easy, steady effort; the week's longest run."),
    ("tempo-run", "Tempo run", "run", "time", "Comfortably hard: about the pace you could hold for an hour."),
    ("intervals", "Intervals", "run", "distance", "Hard repeats with easy jog recoveries; even splits."),
    ("hill-repeats", "Hill repeats", "run", "reps", "Strong uphill, tall posture; walk or jog down to recover."),
    ("strides", "Strides", "run", "reps", "15–20 s relaxed accelerations to near-fast; full recovery."),
    ("recovery-run", "Recovery run", "run", "time", "Very easy and short; slower than feels necessary."),
    ("warm-up-jog", "Warm-up jog", "run", "time", "Easy jog building into the session."),
    # other endurance
    ("endurance-ride", "Endurance ride", "ride", "time", "Steady aerobic riding at an easy, sustainable effort."),
    ("indoor-ride", "Indoor ride", "ride", "time", "Trainer session; keep a fan on and cadence smooth."),
    ("swim", "Swim", "swim", "distance", "Continuous or broken swimming; note the stroke in the item."),
    ("swim-drills", "Swim drills", "swim", "time", "Technique drills, e.g. catch-up, single-arm, kick."),
    ("ice-skate", "Ice skating", "skate", "time", "Low position, full push to the side, recover the leg."),
    ("inline-skate", "Inline skate", "skate", "time", "Low position, full push to the side, recover the leg."),
    ("walk", "Walk", "walk", "distance", "Brisk pace."),
    ("hike", "Hike", "walk", "time", "Note elevation or terrain in the item."),
    ("bouldering", "Bouldering", "climb", "time", "Warm up on easy problems before hard attempts."),
    # strength: lower body
    ("back-squat", "Back squat", "strength", "reps", "Brace, sit between the hips, knees track over toes."),
    ("goblet-squat", "Goblet squat", "strength", "reps", "Weight at the chest, elbows inside the knees, upright torso."),
    ("deadlift", "Deadlift", "strength", "reps", "Bar close, flat back, push the floor away."),
    ("romanian-deadlift", "Romanian deadlift", "strength", "reps", "Soft knees, hinge at the hips until the hamstrings stretch."),
    ("single-leg-rdl", "Single-leg Romanian deadlift", "strength", "reps", "Hips square, reach the free leg back; per leg."),
    ("bulgarian-split-squat", "Bulgarian split squat", "strength", "reps", "Rear foot on a bench, front knee over the foot; per leg."),
    ("walking-lunge", "Walking lunge", "strength", "reps", "Long stride, back knee towards the floor; per leg."),
    ("step-up", "Step-up", "strength", "reps", "Whole foot on the box, drive through the heel; per leg."),
    ("hip-thrust", "Hip thrust", "strength", "reps", "Upper back on a bench, ribs down, squeeze at the top."),
    ("glute-bridge", "Glute bridge", "strength", "reps", "Feet flat, lift the hips without arching the back."),
    ("calf-raise", "Calf raise", "strength", "reps", "Full range, slow down; straight or bent knee."),
    ("nordic-curl", "Nordic curl", "strength", "reps", "Lower as slowly as you can with hips extended."),
    ("box-jump", "Box jump", "strength", "reps", "Land softly and quietly; step down."),
    ("kettlebell-swing", "Kettlebell swing", "strength", "reps", "Hinge, snap the hips; the arms only guide the bell."),
    # strength: upper body
    ("push-up", "Push-up", "strength", "reps", "Body in one line, chest to the floor."),
    ("bench-press", "Bench press", "strength", "reps", "Shoulder blades back, feet planted, bar to the lower chest."),
    ("overhead-press", "Overhead press", "strength", "reps", "Squeeze glutes, press straight up, head through at the top."),
    ("pull-up", "Pull-up", "strength", "reps", "From a dead hang, chest to the bar; band if needed."),
    ("bent-over-row", "Bent-over row", "strength", "reps", "Flat back, pull to the lower ribs."),
    ("dumbbell-row", "Single-arm dumbbell row", "strength", "reps", "Hand and knee on a bench, elbow to the hip; per arm."),
    # trunk
    ("plank", "Plank", "strength", "time", "Forearms under shoulders, ribs down, glutes on."),
    ("side-plank", "Side plank", "strength", "time", "Hips high, body in one line; per side."),
    ("dead-bug", "Dead bug", "strength", "reps", "Low back pressed down while the opposite arm and leg extend."),
    ("pallof-press", "Pallof press", "strength", "reps", "Resist the band's pull; press out and hold; per side."),
    ("copenhagen-plank", "Copenhagen plank", "strength", "time", "Top leg on a bench, lift the hips; per side."),
    # mobility
    ("hip-flexor-stretch", "Hip flexor stretch", "mobility", "time", "Half-kneeling, tuck the pelvis, lean forward gently."),
    ("ankle-mobility", "Ankle mobility", "mobility", "reps", "Knee-to-wall rocks, heel down; per side."),
    ("thoracic-rotation", "Thoracic rotation", "mobility", "reps", "Side-lying open books; follow the hand with your eyes."),
    ("foam-rolling", "Foam rolling", "mobility", "time", "Slow passes over calves, quads, glutes; avoid joints."),
    ("yoga-flow", "Yoga flow", "mobility", "time", "Easy flow; breathe through the nose."),
]

PROFILE_TEMPLATE = """# Profile

## Goals & events
<!-- What are you training for, and by when? Races, events, or a general aim. -->

## Availability
<!-- Which days and how much time per session; anything that changes week to week. -->

## Current training
<!-- What a normal week looks like now: sessions, volume, your longest recent session. -->

## Injuries & constraints
<!-- Past or current injuries, health notes, equipment you do or don't have. -->

## Preferences
<!-- What you enjoy or avoid, preferred long-run day, how you like feedback. -->
"""


def install(db: Session) -> ChangeResult | None:
    if db.scalars(select(Exercise.id)).first() is not None or current_profile(db) is not None:
        return None
    ops: list[dict] = [{"op": "add_exercise", "id": i, "name": n, "type": t, "default_measure": m, "notes": c}
                       for i, n, t, m, c in EXERCISES]
    ops.append({"op": "update_profile", "markdown": PROFILE_TEMPLATE})
    return apply_change(db, ops, source="system", reason="Starter exercise list and Profile template")
