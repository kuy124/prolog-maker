/**
 * A knowledge base written as clauses must survive being asserted into.
 *
 * This was the reported failure, reached through the old Facts panel:
 *
 *     assert/1: No permission to modify static procedure observation/1
 *     Defined at /tmp/room/facts.pl:1
 *
 * A fact named `observation(ada)` became a clause in a generated `facts.pl`, a
 * predicate defined by clauses is static, and the programme's `assert/1` was
 * refused — with an error naming a file the user never wrote.
 *
 * Facts are now ordinary clauses in the program, so there is no second file and no
 * second set of rules. What is still worth holding is the thing that broke: a
 * program may declare a predicate dynamic, assert into it, and read it back, all
 * while the program also contains clauses for that predicate.
 */

import { expect, test } from '@playwright/test';
import { openApp, waitForEngine } from './helpers';

/** The IKM expert system, with the `dynamic` directive it genuinely needs. */
const PROGRAM = `:- dynamic(observation/1).

mulai :-
      write('Mulai. Jawab dengan y atau t.~n'),
      pertanyaan(Tanya, Obs),
      write(Tanya), nl,
      read(Yatidak),
      Yatidak = y,
      assert(observation(Obs)),
      fail.
mulai :-
      (   observation(aspirations_pnj)
      ->  write('Kesimpulan: ongyang Booster.')
      ;   write('Kesimpulan: tidak ada yang cocok.')
      ),
      nl,
      retractall(observation(_)).

pertanyaan('PNJ?', aspirations_pnj).
`;

const ask = async (page: import('@playwright/test').Page, goal: string) => {
  await page.locator('.console__input').fill(goal);
  await page.locator('.console__input').press('Enter');
  await expect(page.locator('.terminal__text')).toBeVisible();
  return page.locator('.terminal__text').innerText();
};

test('a program may assert into a predicate it also defines', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);
  await page.locator('.editor__input').fill(PROGRAM);
  // Let the debounced consult land.
  await page.waitForTimeout(900);

  const output = await ask(page, 'mulai.');
  // The programme asked its question, so it is suspended rather than finished.
  await expect(page.locator('.note--waiting')).toBeVisible();

  await page.locator('.console__input').fill('y');
  await page.locator('.console__input').press('Enter');

  await expect(page.locator('.terminal__text')).toContainText('Kesimpulan: ongyang Booster.', {
    timeout: 10_000,
  });
  expect(output).toContain('Mulai.');
});

test('the transcript echoes the goal and the answer', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);
  await page.locator('.editor__input').fill(PROGRAM);
  await page.waitForTimeout(900);

  await page.locator('.console__input').fill('mulai.');
  await page.locator('.console__input').press('Enter');
  await expect(page.locator('.note--waiting')).toBeVisible();

  await page.locator('.console__input').fill('y');
  await page.locator('.console__input').press('Enter');
  await expect(page.locator('.terminal__text')).toContainText('Kesimpulan', { timeout: 10_000 });

  const transcript = await page.locator('.terminal__text').innerText();
  // A session reads back the way it was typed: the goal at the top level prompt,
  // each answer at the continuation prompt.
  expect(transcript).toContain('?- mulai.');
  expect(transcript).toContain('|: y.');
});

test('a retracted assertion stops matching, so the rule falls through', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);
  await page.locator('.editor__input').fill(PROGRAM);
  await page.waitForTimeout(900);

  // Answer "t" so nothing is asserted; the second clause must reach its else.
  await ask(page, 'mulai.');
  await expect(page.locator('.note--waiting')).toBeVisible();
  await page.locator('.console__input').fill('t');
  await page.locator('.console__input').press('Enter');

  await expect(page.locator('.terminal__text')).toContainText('tidak ada yang cocok', {
    timeout: 10_000,
  });
});
