/**
 * The terminal: a goal stops at a question and carries on when it is answered.
 *
 * This is the thing the queue of answers could not do. A programme that calls
 * `read/1` has to stop mid-execution and resume from that point, which is what a
 * Prolog top level does and what nothing else here manages:
 *
 *   - `read/1` has no JavaScript input path. Emscripten's stdin hook reads
 *     `process.stdin` or `window.prompt`, and a worker has neither.
 *   - `await/2`, which would suspend and resume a goal with a value, raises
 *     `permission_error(run, ...)`.
 *   - `Atomics.wait` would block, but SharedArrayBuffer needs cross-origin
 *     isolation, and the deployed site reports `crossOriginIsolated === false`.
 *
 * What works is throwing. The engine suspends, the host re-enters the goal with one
 * more answer, and the deterministic prefix replays to exactly where it stopped.
 *
 * The IKM PNJ expert system is the test programme, because it is what the
 * capability is for: six questions, read from the keyboard, one answer at a time.
 */

import { expect, test } from '@playwright/test';
import { openApp, readRows, waitForEngine } from './helpers';

/**
 * The programme as the user has it.
 *
 * `:- dynamic(observation/1).` is here and not in the fixture's comments: without it
 * the predicate only comes into existence when `assert/1` runs, and calling it when it
 * does not exist raises `Unknown procedure` rather than failing.
 */
const PROGRAM = `% SISTEM PAKAR HIERARKI DAN FUNGSI ORMAWA IKM PNJ
% Cara run: setelah consult file PL, ketik perintah mulai.

:- dynamic(observation/1).

mulai:-
      init,
      data_pengamatan,
      aturan(Nomor,Alasan),
      jawaban(Alasan,Jawab),
      write(Jawab),nl,
      write('Aturan  '),
      write(Nomor),nl,nl,
      penjelasan(Alasan),
      retractall(observation(_)),
      !.
mulai:-
      write('Maaf, sistem tidak menemukan lembaga yang cocok berdasarkan jawaban Anda.'),nl,nl.

init:-
      write('PROGRAM SISTEM PAKAR ORMAWA IKM PNJ'),nl,
      judul(Judul),write(Judul),nl,nl,
      tulis_pesan,nl.

tulis_pesan:-
      pesan(Pesan),
      write(Pesan),nl,fail.
tulis_pesan:-
      nl.

data_pengamatan:-
      pertanyaan(Tanya,Obs),
      write(Tanya),nl,
      read(Yatidak),
      Yatidak=y,
      assert(observation(Obs)),
      fail.
data_pengamatan.

judul('IDENTIFIKASI LEMBAGA TUJUAN ASPIRASI MAHASISWA').
pesan('Jawab pertanyaan berikut dengan y atau t').

pertanyaan('Apakah aspirasi Anda berkaitan dengan program tingkat PNJ ?', aspirasi_pnj).
pertanyaan('Apakah aspirasi Anda berkaitan dengan masalah di tingkat jurusan ?', aspirasi_jurusan).
pertanyaan('Apakah aspirasi Anda terkait kegiatan UKM ?', aspirasi_ukm).
pertanyaan('Apakah aspirasi Anda membutuhkan pengawasan MPM ?', pengawasan_mpm).
pertanyaan('Apakah Anda ingin melaporkan pelanggaran pengurus ?', laporan_pelanggaran).
pertanyaan('Apakah aspirasi Anda terkait Badan Otonom ?', aspirasi_bo).

aturan(1, bem):- observation(aspirasi_pnj).
aturan(2, hmj):- observation(aspirasi_jurusan).
aturan(3, bem):- observation(aspirasi_ukm).
aturan(4, mpm):- observation(pengawasan_mpm).
aturan(5, mpm):- observation(laporan_pelanggaran).
aturan(6, mpm):- observation(aspirasi_bo).

jawaban(mpm, 'MPM menjalankan legislatif dan yudikatif, menampung aspirasi, serta mengawasi BEM/HMJ.').
jawaban(bem, 'BEM menjalankan fungsi eksekutif di tingkat PNJ dan menindaklanjuti aspirasi mahasiswa.').
jawaban(hmj, 'HMJ menjalankan fungsi eksekutif di tingkat jurusan.').

penjelasan(mpm):- nl,write('MPM berwenang membuat peraturan dan mengawasi BEM/HMJ.'),nl,nl.
penjelasan(bem):- nl,write('BEM berkewajiban menindaklanjuti aspirasi tingkat PNJ.'),nl,nl.
penjelasan(hmj):- nl,write('HMJ berkewajiban menindaklanjuti aspirasi tingkat jurusan.'),nl,nl.
`;

/**
 * The transcript, read from `textContent` so wrapping is not mistaken for output.
 *
 * The count is checked first on purpose: `textContent()` waits for the element, and
 * the terminal block is simply absent when a goal printed nothing — so asking for its
 * text directly would sit out the full timeout on every such assertion.
 */
async function transcript(page: import('@playwright/test').Page): Promise<string> {
  const block = page.locator('.terminal__text');
  if ((await block.count()) === 0) return '';
  return (await block.first().textContent()) ?? '';
}

async function loadProgram(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.editor__input').fill(PROGRAM);
  await page.waitForTimeout(900);
}

test('stops at the first question and waits for an answer', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);
  await loadProgram(page);

  await page.locator('.console__input').fill('mulai.');
  await page.locator('.console__input').press('Enter');

  // The programme gets as far as its first question and stops. It must not run on
  // and print the rest: that is what a failing read/1 does, and it is the bug this
  // whole mechanism exists to fix.
  await expect(page.locator('.note--waiting')).toBeVisible({ timeout: 30_000 });
  const text = await transcript(page);
  expect(text).toContain('PROGRAM SISTEM PAKAR ORMAWA IKM PNJ');
  expect(text).toContain('Apakah aspirasi Anda berkaitan dengan program tingkat PNJ ?');
  expect(text).not.toContain('Apakah aspirasi Anda terkait kegiatan UKM ?');

  // No error: it asked a question, it did not break.
  await expect(page.locator('.note--error')).toHaveCount(0);
});

test('answers one question at a time, like a Prolog top level', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);
  await loadProgram(page);

  await page.locator('.console__input').fill('mulai.');
  await page.locator('.console__input').press('Enter');
  await expect(page.locator('.note--waiting')).toBeVisible({ timeout: 30_000 });

  const prompt = page.locator('.console__input');

  /*
   * All six questions, in the order the programme asks them, one answer at a time.
   *
   * Every question is answered, not just the first few: the questionnaire keeps
   * asking until its list runs out, so stopping early leaves it waiting rather than
   * reaching a conclusion.
   *
   * Only the first is `y`. Each answer is consumed — if the replay re-offered the
   * first answer, every question would record it and rule 1 would match six times
   * over instead of once.
   */
  const questions = [
    'Apakah aspirasi Anda berkaitan dengan program tingkat PNJ ?',
    'Apakah aspirasi Anda berkaitan dengan masalah di tingkat jurusan ?',
    'Apakah aspirasi Anda terkait kegiatan UKM ?',
    'Apakah aspirasi Anda membutuhkan pengawasan MPM ?',
    'Apakah Anda ingin melaporkan pelanggaran pengurus ?',
    'Apakah aspirasi Anda terkait Badan Otonom ?',
  ];

  for (const [index, question] of questions.entries()) {
    await expect.poll(async () => transcript(page)).toContain(question);
    await expect(page.locator('.note--waiting')).toBeVisible();
    await prompt.fill(index === 0 ? 'y' : 't');
    await prompt.press('Enter');
  }

  await expect(page.locator('.note--waiting')).toHaveCount(0, { timeout: 30_000 });
  const text = await transcript(page);
  expect(text).toContain('Aturan  1');
  expect(text).toContain('BEM menjalankan fungsi eksekutif');
});

test('the transcript reads as one session, not a series of replays', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);
  await loadProgram(page);

  await page.locator('.console__input').fill('mulai.');
  await page.locator('.console__input').press('Enter');
  await expect(page.locator('.note--waiting')).toBeVisible({ timeout: 30_000 });

  /*
   * Six answers, one per question. The transcript must grow after each one — that is
   * what proves the attempt advanced rather than stopping at the same question again.
   */
  const prompt = page.locator('.console__input');
  let seen = await transcript(page);
  for (const value of ['y', 't', 't', 't', 't', 't']) {
    await expect(page.locator('.note--waiting')).toBeVisible({ timeout: 30_000 });
    await prompt.fill(value);
    await prompt.press('Enter');
    await expect
      .poll(async () => transcript(page), { timeout: 30_000 })
      .not.toBe(seen);
    seen = await transcript(page);
  }

  await expect(page.locator('.note--waiting')).toHaveCount(0, { timeout: 30_000 });
  const text = seen;

  /*
   * The replayed prefix must not accumulate. Each attempt re-runs the deterministic
   * work before the read, so if the transcript were simply appended the banner would
   * appear six times over. It appears once.
   */
  const banners = text.split('PROGRAM SISTEM PAKAR ORMAWA IKM PNJ').length - 1;
  expect(banners).toBe(1);

  const questions = text.split('Apakah aspirasi Anda berkaitan dengan program tingkat PNJ ?').length - 1;
  expect(questions).toBe(1);
});

test('a wrong answer is an answer, not a mistake', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);
  await loadProgram(page);

  await page.locator('.console__input').fill('mulai.');
  await page.locator('.console__input').press('Enter');
  await expect(page.locator('.note--waiting')).toBeVisible({ timeout: 30_000 });

  // Answering "n" where the programme expects "y" is a valid term. It is not a
  // syntax error and it must not be reported as one.
  await page.locator('.console__input').fill('n.');
  await page.locator('.console__input').press('Enter');

  await expect(page.locator('.note--waiting')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.note--error')).toHaveCount(0);
});

test('a goal that never reads behaves exactly as before', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  await page.locator('.console__input').fill('likes(ada, X).');
  await page.locator('.console__input').press('Enter');

  // Generous, because this suite runs three WebAssembly engines in parallel and the
  // goal waits behind whichever one is still booting. It passed in 1.1s alone and
  // timed out at 30s in the full run.
  await expect(page.locator('.results')).toBeVisible({ timeout: 60_000 });
  expect((await readRows(page)).join(' ')).toContain('prolog');
  // No prompt, because nothing asked anything.
  await expect(page.locator('.note--waiting')).toHaveCount(0);
});

test('an answer may be a whole term, not just y or t', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  // read/1 parses a term, so anything that parses is a legal answer. The point is
  // that the shim puts what was typed into the queue verbatim rather than trying to
  // normalise it into a yes/no.
  await page.locator('.editor__input').fill('ask(A) :- read(A), write(got(A)), nl.\n');
  await page.waitForTimeout(900);

  await page.locator('.console__input').fill('ask(_).');
  await page.locator('.console__input').press('Enter');
  await expect(page.locator('.note--waiting')).toBeVisible({ timeout: 30_000 });

  await page.locator('.console__input').fill('person(ada, prolog)');
  await page.locator('.console__input').press('Enter');

  await expect(page.locator('.note--waiting')).toHaveCount(0, { timeout: 30_000 });
  // Written by `write/1`, so the compound reads without its argument spaces.
  await expect(page.locator('.terminal__text')).toContainText('got(person(ada,prolog))');
});

test('a fresh goal abandons a suspended one', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  // A small questionnaire rather than the IKM programme: what is being tested is the
  // way out of a prompt, and the expert system's six questions only make it slower.
  await page
    .locator('.editor__input')
    .fill("tanya(N, O) :- write(N), nl, read(Jawab), Jawab = y, assert(sEDED(O)), fail.\n");
  await page.waitForTimeout(900);

  await page.locator('.console__input').fill('tanya(pertama, satu).');
  await page.locator('.console__input').press('Enter');
  await expect(page.locator('.note--waiting')).toBeVisible({ timeout: 30_000 });

  /*
   * Abandoning a questionnaire has to be possible, or a wrong answer leaves the room
   * stuck at a prompt nobody can leave.
   *
   * It is not enough for a fresh goal to supersede the suspended one — every line
   * typed at a waiting prompt is an answer, so there has to be an explicit way out.
   */
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('.note--waiting')).toHaveCount(0);

  await page.locator('.console__input').fill('current_prolog_flag(toplevel_goal, T).');
  await page.locator('.console__input').press('Enter');

  await expect(page.locator('.results')).toBeVisible({ timeout: 30_000 });
  expect((await readRows(page)).length).toBe(1);
  await expect(page.locator('.note--waiting')).toHaveCount(0);

  // The questionnaire's output is gone with it. This goal prints nothing, so the
  // terminal block is not rendered at all.
  expect(await transcript(page)).toBe('');
});



