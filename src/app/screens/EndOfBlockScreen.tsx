// Task 24 — the five(-ish)-option end-of-block prompt. `options` is exactly what the engine
// offered (the 60-second gate substitutes `skip` for `park` before it, never both) — this screen
// renders only what's present, in a fixed visual order, and never invents or swaps an option.
// No back action here: the prompt is a required stop, not a page you can back out of.

import { Body, Caption, Eyebrow, Heading, PrimaryButton, Screen, ScrollBody, SecondaryButton, Stack, TertiaryButton } from '../components';
import { spacing } from '../theme';
import type { EndOfBlockProps } from './contracts';

export default function EndOfBlockScreen(props: EndOfBlockProps) {
  const {
    taskTitle,
    workedMinutes,
    options,
    selfCareNudge,
    onDone,
    onPlusFive,
    onKeepGoing,
    onPark,
    onSkip,
    onSomethingEasier,
  } = props;

  const has = (option: EndOfBlockProps['options'][number]) => options.includes(option);

  return (
    <Screen>
      <ScrollBody>
        <Stack gap={spacing.lg}>
          <Stack gap={spacing.xs}>
            <Eyebrow>Block ended</Eyebrow>
            <Heading>{taskTitle}</Heading>
            <Body>Where are you with it?</Body>
            <Body>
              {workedMinutes} minute{workedMinutes === 1 ? '' : 's'} worked this block.
            </Body>
          </Stack>

          {selfCareNudge ? (
            <Caption>You've been in flow a while — water, stretch, still going?</Caption>
          ) : null}

          <Stack gap={spacing.md}>
            {has('done') ? <PrimaryButton title="Done" onPress={onDone} /> : null}
            {has('short_extension') ? <SecondaryButton title="+5 minutes" onPress={onPlusFive} /> : null}
            {has('keep_going') ? <SecondaryButton title="Keep going" onPress={onKeepGoing} /> : null}
            {has('park') ? <TertiaryButton title="Pause for later" onPress={onPark} /> : null}
            {has('skip') ? <TertiaryButton title="Not this one" onPress={onSkip} /> : null}
            {has('easier') ? <TertiaryButton title="Something easier" onPress={onSomethingEasier} /> : null}
          </Stack>

          <Caption>Paused work keeps everything you got done — it comes back later.</Caption>
        </Stack>
      </ScrollBody>
    </Screen>
  );
}
