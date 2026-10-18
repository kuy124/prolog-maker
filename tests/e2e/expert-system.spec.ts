/**
 * The expert system, end to end, in the browser.
 *
 * This is the shape of program the console exists for: a questionnaire that reads
 * answers and prints a conclusion. Two things about the WebAssembly build make it
 * work, and both are easy to get wrong — `read/1` cannot be fed from JavaScript,
 * and `nl/0` never reaches the bridge's output callback — so the test asserts on
 * the rendered transcript rather than merely on the fact that a goal succeeded.
 */

import { expect, test } from '@playwright/test';
import { openApp, readRows, waitForEngine } from './helpers';

/**
 * `:- dynamic(observation/1).` is not optional.
 *
 * Without it the predicate only comes into existence when `assert/1` runs. If no
 * answer is `y`, nothing is asserted, so `observation/1` never exists — and
 * calling an undeclared predicate raises `Unknown procedure` rather than failing.
 * That error escapes clause 1 of `mulai/0`, so the `default` clause is never
 * reached and the programme stops with an error instead of its own apology.
 */
/**
 * Two corrections to the original programme, both required and both about Prolog
 * rather than about this app.
 *
 * 1. `:- dynamic(observation/1).` Without it the predicate only comes into
 *    existence when `assert/1` runs. If no answer is `y`, nothing is asserted, so
 *    `observation/1` never exists — and calling an undeclared predicate raises
 *    `Unknown procedure` rather than failing.
 *
 * 2. The fallback must be a second clause of `mulai/0`, not a separate predicate.
 *    Written as `default:- ...` it is `default/0`, and nothing ever calls it, so
 *    the programme stops on `Observation` rather than reaching its own apology.
 *    The head has to read `mulai:-` for the cut in clause 1 to fall through to it.
 *
 * The tests below assert both, so neither mistake can come back quietly.
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

test('runs a questionnaire and prints a conclusion', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  await page.locator('.editor__input').fill(PROGRAM);
  await page.waitForTimeout(900);

  // Queue six answers, the way a person fills in a questionnaire.
  const answer = page.locator('.answers__input');
  for (const value of ['y', 't', 'y', 't', 't', 't']) {
    await answer.fill(value);
    await answer.press('Enter');
  }
  await expect(page.locator('.answers__chip')).toHaveCount(6);

  await page.locator('.console__input').fill('mulai.');
  await page.locator('.console__input').press('Enter');

  const transcript = page.locator('.terminal__text');
  await expect(transcript).toBeVisible({ timeout: 30_000 });
  await expect(transcript).toContainText('PROGRAM SISTEM PAKAR ORMAWA IKM PNJ', { timeout: 30_000 });

  /*
   * `innerText` is read from `textContent`, not from the rendered layout: the
   * transcript is `white-space: pre-wrap`, so the browser wraps a long line for
   * display and `innerText` reports the wrap as a newline. That would make every
   * assertion about line breaks a statement about the pane's width rather than
   * about the program's output.
   */
  const text = (await transcript.textContent()) ?? '';

  // Newlines must survive. Read through the bridge's output callback Emscripten
  // discards them, and every one of these lines collapses into the next.
  expect(text.split('\n')[0]).toBe('PROGRAM SISTEM PAKAR ORMAWA IKM PNJ');
  expect(text).toContain('IDENTIFIKASI LEMBAGA TUJUAN ASPIRASI MAHASISWA\n');
  expect(text).toContain('Jawab pertanyaan berikut dengan y atau t\n');
  expect(text).toContain('Apakah aspirasi Anda berkaitan dengan program tingkat PNJ ?\n');

  // The first rule matches the first `y`, so the conclusion is the BEM's.
  expect(text).toContain('Aturan  1\n');
  expect(text).toContain('BEM menjalankan fungsi eksekutif');
  expect(text).toContain('BEM berkewajiban');

  // A `mulai` with a cut produces exactly one solution, and it binds nothing.
  await expect(page.locator('.results')).toHaveCount(1);
  expect((await readRows(page)).join(' ')).toContain('yes');
});

test('answers are consumed in order, so different answers give a different rule', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  await page.locator('.editor__input').fill(PROGRAM);
  await page.waitForTimeout(900);

  const answer = page.locator('.answers__input');
  for (const value of ['t', 'y', 't', 't', 't', 't']) {
    await answer.fill(value);
    await answer.press('Enter');
  }

  await page.locator('.console__input').fill('mulai.');
  await page.locator('.console__input').press('Enter');

  const transcript = page.locator('.terminal__text');
  await expect(transcript).toContainText('Aturan  2', { timeout: 30_000 });
  await expect(transcript).toContainText('HMJ menjalankan fungsi eksekutif');
});

test('a questionnaire with no answers falls through to the default answer', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  await page.locator('.editor__input').fill(PROGRAM);
  await page.waitForTimeout(900);

  // Nothing queued. Every read/1 returns end_of_file, which is not `y`, so no
  // observation is asserted, aturan/2 has nothing to match, clause 1 of mulai/0
  // fails, and the default clause answers.
  await page.locator('.console__input').fill('mulai.');
  await page.locator('.console__input').press('Enter');

  await expect(page.locator('.terminal__text')).toContainText(
    'Maaf, sistem tidak menemukan lembaga yang cocok',
    { timeout: 30_000 },
  );
});

test('an undeclared predicate is reported as an error, not as a wrong answer', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  // With `:- dynamic(observation/1).` removed and no answers given, nothing is
  // asserted so the predicate never exists and the call raises. Falling through to
  // the fallback here would hide a real defect, so the error has to reach the
  // console.
  await page
    .locator('.editor__input')
    .fill(PROGRAM.replace(':- dynamic(observation/1).\n', ''));
  await page.waitForTimeout(900);

  await page.locator('.console__input').fill('mulai.');
  await page.locator('.console__input').press('Enter');

  await expect(page.locator('.note--error')).toContainText('Unknown procedure', {
    timeout: 30_000,
  });
  await expect(page.locator('.note--error')).toContainText('observation/1');
  await expect(page.locator('.terminal__text')).not.toContainText('Maaf, sistem tidak menemukan');
});

test('a fallback written as its own predicate is never reached', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  // `default:- ...` on its own line declares `default/0`, which nothing calls, so
  // the programme stops on an exception instead of printing its own apology. This
  // test exists because it is the mistake the original programme made and it looks
  // correct at a glance.
  await page
    .locator('.editor__input')
    .fill(PROGRAM.replace("mulai:-\n      write('Maaf,", "default:-\n      write('Maaf,"));
  await page.waitForTimeout(900);

  await page.locator('.console__input').fill('mulai.');
  await page.locator('.console__input').press('Enter');

  await expect(page.locator('.terminal__text')).toContainText('PROGRAM SISTEM PAKAR', {
    timeout: 30_000,
  });
  await expect(page.locator('.terminal__text')).not.toContainText('Maaf, sistem tidak menemukan');
});
