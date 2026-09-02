/**
 * The three numbers every dialog animation is measured in, and the one phase
 * test that reads them.
 *
 * They live together, and alone, because the tests wait against the same
 * constants the dialogs animate on: a test that slept a literal number of
 * milliseconds would race the renderer's own throttle, and a bound the spec
 * sets would be checked against a number nothing else uses.
 */

/** How long the caret and the overflow indicator hold each phase. The spec puts
 * the caret's blink between 400 and 600 milliseconds, and the indicator pulses
 * on the same subscription, so it is one number rather than two: a second
 * subscription at a second interval would drift out of phase with the first and
 * wake the renderer's shared timer twice as often, each wake a full frame. */
export const animationInterval = 500;

/** How long the confirmation flash holds each phase. The renderer coalesces
 * animation ticks inside its render throttle — about 34 milliseconds at its
 * default of thirty frames a second — so a shorter interval would drop ticks
 * rather than blink faster. */
export const flashInterval = 60;

/** How long the confirmation flash runs before the dialog settles: three of its
 * frames, which leaves the settlement well inside the 250 milliseconds the spec
 * allows even when the last tick arrives late. Elapsed time is what ends the
 * flash, never a frame number, precisely because a tick inside the render
 * throttle is dropped rather than delivered. */
export const flashDuration = 180;

/**
 * Whether an element blinking at `interval` is on the phase it shows itself
 * on — the caret visible, the overflow indicator dimmed, the cursor bar
 * inverted — after `elapsed` milliseconds of animation.
 *
 * Phase is read from elapsed time rather than from the subscription's frame
 * counter because one subscription drives elements that blink at different
 * rates: the flash runs the shared timer faster for as long as it lasts, and a
 * frame counter would carry that faster rate to the caret and the indicator as
 * a side effect. Elapsed time restarts with the flash and never reaches one
 * caret interval inside it, so both simply hold their opening phase for the
 * whole of it, and no element needs a special case saying so.
 *
 * Zero is that phase, so a dialog opens — and a reset lands — with its caret on
 * screen rather than a blink away from it.
 */
export function onPhase(elapsed: number, interval: number): boolean {
  return Math.floor(elapsed / interval) % 2 === 0;
}
