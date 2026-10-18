/**
 * A fact in the Facts panel must not make the predicate static.
 *
 * This was the reported failure, reached through the UI rather than the engine:
 *
 *     assert/1: No permission to modify static procedure observation/1
 *     Defined at /tmp/room/facts.pl:1
 *
 * A fact named `observation(ada)` became a clause in `facts.pl`, a predicate defined
 * by clauses is static, and the programme's `assert/1` was refused — with an error
 * naming a file the user never wrote. The programme here deliberately has no
 * `:- dynamic(observation/1).` of its own, because the facts panel supplying one is
 * the whole claim.
 */

import { expect, test } from '@playwright/test';
import { openApp, readRows, waitForEngine } from './helpers';

/** The IKM expert system, minus the `dynamic` directive it would normally carry. */
const PROGRAM = `mulai :-
      write('Mulai. Jawab dengan y atau t.~n'),
      pertanyaan(Tanya, Obs),
      write(Tanya), nl,
      read(Yatidak),
      Yatidak = y,
      assert(observation(Obs)),
      fail.
mulai :-
      (   observation(pnj)
      ->  write('Kesimpulan:ongyang Booster.')
      ;   write('Kesimpulan: tidak ada yang cocok.')
      ),
      nl,
      retractall(observation(_)).

pertanyaan('PNJ?', aspirations_pnj).
`;

const addFact = async (page: import('@playwright/test').Page, term: string) => {
  await page.getByLabel('New fact').fill(term);
  await page.locator('.facts__form button[type=submit]').click();
  await expect(page.locator('.facts__term')).toContainText(term);
};

test('a fact in the panel does not make the program unable to assert into it', async ({
  context,
}) => {
  const page = await openApp(context);
  await waitForEngine(page);

  await page.locator('.editor__input').fill(PROGRAM);
  await page.waitForTimeout(900);
  // The fact whose name the program asserts into. This is what made it static.
  await addFact(page, 'observation(1)');

  await page.locator('.console__input').fill('mulai.');
  await page.locator('.console__input').press('Enter');
  await expect(page.locator('.note--waiting')).toBeVisible({ timeout: 30_000 });

  await page.locator('.console__input').fill('y');
  await page.locator('.console__input').press('Enter');

  // The permission error would land here, naming facts.pl.
  await expect(page.locator('.note--error')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.terminal__text')).toContainText('Kesimpulan:');
});

test('the program still asserts correctly after the facts change', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  await page.locator('.editor__input').fill(PROGRAM);
  await page.waitForTimeout(900);
  await addFact(page, 'observation(1)');

  await page.locator('.console__input').fill('mulai.');
  await page.locator('.console__input').press('Enter');
  await expect(page.locator('.note--waiting')).toBeVisible({ timeout: 30_000 });
  await page.locator('.console__input').fill('y');
  await page.locator('.console__input').press('Enter');
  await expect(page.locator('.note--error')).toHaveCount(0, { timeout: 30_000 });

  /*
   * Remove the fact and run again. Every keystroke re-consults, so this is where a
   * declaration that only survived the first load would fall over — and where a
   * predicate that survived as static would refuse `assert/1` a second time.
   */
  await page.locator('.facts__item button').first().click();
  await expect(page.locator('.facts__term')).toHaveCount(0);

  await page.locator('.console__input').fill('mulai.');
  await page.locator('.console__input').press('Enter');
  await expect(page.locator('.note--waiting')).toBeVisible({ timeout: 30_000 });
  await page.locator('.console__input').fill('y');
  await page.locator('.console__input').press('Enter');

  await expect(page.locator('.note--error')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.terminal__text')).toContainText('Kesimpulan:');
});

test('a fact whose name is a built-in does not stop the room loading', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  /*
   * `:- dynamic(fail/0)` is a permission error, and an unguarded one would take down
   * every consult in the room rather than skipping one declaration.
   */
  await addFact(page, 'not(a_thing)');
  await page.locator('.console__input').fill('current_prolog_flag(unknown, U).');
  await page.locator('.console__input').press('Enter');

  await expect(page.locator('.results')).toBeVisible({ timeout: 30_000 });
  expect((await readRows(page)).length).toBe(1);
  await expect(page.locator('.note--error')).toHaveCount(0);
});