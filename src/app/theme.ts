// Task 24 — the design tokens, lifted from the task 23 prototype (docs/design/Main Screen.dc.html
// + Coaching Screen.dc.html) so the functional pass already speaks the designed visual language
// rather than inventing a second one that has to be unpicked at the beta gate.
//
// SCOPE: this is the MINIMAL token set the functional pass needs — one green, one text ramp, one
// radius ladder. The full designed pass (task 23's system applied throughout: motion, elevation,
// dark mode, the type scale) is beta-gate work. Adding tokens here is cheap; using them to grow
// the personal-ship deliverable is not.

export const colors = {
  /** Page background behind every screen. */
  background: '#F7F7F8',
  /** Cards, inputs, headers — anything raised off the background. */
  surface: '#FFFFFF',
  border: '#E5E5EA',
  /** Input borders: one step darker than a card edge so fields read as interactive. */
  borderInput: '#D9D9DE',
  /** Low-emphasis button outline (the escape valve, "not with me"). */
  borderMuted: '#C9C9CF',
  text: '#1B1B1F',
  textSecondary: '#49454F',
  textMuted: '#6B6B70',
  /** The single accent. One green, used for every affirmative affordance. */
  primary: '#3A5A40',
  primaryPressed: '#2C4531',
  onPrimary: '#FFFFFF',
  /** Destructive only (delete). Never used for a task outcome — declining a task is not an error. */
  danger: '#C9494A',
  disabled: '#B3B3B8',
  /** The paused timer face. Grey, not red: an interruption is not a failure. */
  paused: '#6B6B70',
} as const;

export const radius = {
  sm: 12,
  md: 14,
  lg: 16,
  pill: 20,
  button: 24,
  buttonLarge: 28,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const fontSize = {
  caption: 13,
  small: 14,
  body: 15,
  input: 16,
  title: 17,
  heading: 20,
  display: 22,
  /** The dominant timer face (spec §6.2: the timer is the screen). */
  timer: 34,
} as const;

/** One shadow, on the primary call to action only. */
export const shadow = {
  button: {
    elevation: 2,
    shadowColor: '#000000',
    shadowOpacity: 0.15,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  timer: {
    elevation: 6,
    shadowColor: colors.primary,
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
  },
} as const;
