# Sokoban Solver — make.fun bounty "Build the best Sokoban solver"

Solver Sokoban untuk bounty make.fun
**["Build the best Sokoban solver"](https://make.fun/bounty/sokoban-solver-01-run-20261121)**
(hadiah total $100, peringkat 1–10 masing-masing $10; deadline
**Senin 23 Nov 2026 jam 10:00 WIB**).

> Repo ini disubmit ke bounty make.fun "Build the best Sokoban solver"
> pada 22 Nov 2026 atas persetujuan Ryan Gusti Nugraha. Folder `tests/`
> (harness + 12 level contoh) hanya dipakai untuk verifikasi lokal dan
> tidak ikut disubmit — grader hanya butuh `main.ts`.

## Deliverable

```
makefun-sokoban/
├── main.ts                  # SATU program, Node 22, tanpa dependency
├── README.md
└── LICENSE                  # MIT
```

Repo ~37 KiB (batas 1 MiB). `main.ts` hanya memakai sintaks TypeScript
yang erasable (type stripping Node 22) dan hanya import `node:fs`,
`node:path`, `node:url` — tanpa dependency, tanpa install, tanpa WASM.

## Cara pakai

```bash
# Dijalankan grader sebagai: node /bot/main.ts
#   input : /input/<id>/level.txt
#   output: /output/<id>/solution.txt

# Lokal (untuk test): arahkan via env var
INPUT_DIR=/tmp/in OUTPUT_DIR=/tmp/out node main.ts

# Jalankan semua test (simulasi grader, hanya di salinan lokal)
node tests/run_tests.mjs
```

## Spek yang dipenuhi

| Aturan bounty | Implementasi |
| --- | --- |
| Satu program `main.ts`, Node 22, JS/TS saja | Ya — satu file, tanpa dependency |
| `node /bot/main.ts`, 60 detik total, 1 CPU, 512 MB, tanpa network | Anggaran internal 50 detik (margin 10 detik); tidak ada akses network |
| Deterministik (dua run = byte identik) | Urutan instance terurut, heap dengan tie-break deterministik (counter), tanpa random; batas waktu hanya pemutus darurat |
| Input `/input/<id>/level.txt` format XSB | `# @ $ . * +` diparse di `parseLevel` |
| Output `/output/<id>/solution.txt`, UTF-8, maks 65.536 byte, huruf `L/U/R/D` (huruf kecil = push) | String langkah konvensi standar: huruf besar = jalan kaki, huruf kecil = dorongan; whitespace diabaikan grader |
| Wajib jawab SEMUA instance dalam format | Setiap instance selalu ditulis filenya — kosong kalau tidak ketemu solusi (file kosong adalah solusi valid); level rusak juga menghasilkan file kosong, bukan crash |
| Push-optimal (1000 poin) / parsial `500 × P*/pushes` | A* dengan heuristik admissible -> push-optimal bila fase optimal selesai (lihat Algoritma) |

## Algoritma

- **Push-based A\***: state = (posisi semua kotak, posisi pemain).
  Dari satu state, semua dorongan yang mungkin dihitung lewat flood-fill
  area yang bisa dicapai pemain. Jauh lebih kecil daripada pencarian
  per-langkah.
- **Heuristik admissible**: minimum-cost matching kotak→target
  (**Hungarian** O(n³), jarak BFS mengabaikan kotak lain) untuk ≤10 kotak;
  jumlah jarak minimum untuk yang lebih besar. Satu dorongan mengubah
  jarak satu kotak paling banyak 1, jadi total dorongan minimal ≥ biaya
  matching — admissible. A* admissible mengembalikan solusi dengan
  **jumlah push minimal (optimal)**.
- **Deadlock detection** (semua sound — tidak pernah membuang state yang
  masih bisa menang):
  - dead square statis: sudut, dan segmen dinding yang **tertutup di
    kedua ujung** tanpa target (lihat catatan bug di bawah);
  - blok 2x2 penuh dinding/kotak berisi kotak bukan-target;
  - kotak beku (tidak bisa bergerak di kedua sumbu, dihitung iteratif
    sampai fixpoint).
- **Transposition table**: state yang sama (kotak + region pemain yang
  dicapai, dinormalisasi ke petak kanonik) hanya diekspansi sekali.
- **Dua fase per instance**:
  1. *Weighted A\** (w=2, node cap 150k) — cari solusi feasible dulu
     sebagai fallback (partial credit kalau fase optimal kehabisan waktu).
  2. *A\* optimal* (node cap 500k) dengan branch-and-bound terhadap
     incumbent: state dengan `g + h >= bestPushes` dipangkas. Kalau fase
     1 sudah mencapai lower bound heuristik, fase 2 dilewati (sudah
     terbukti optimal).
- **Verifikasi internal**: setiap solusi yang dihasilkan di-replay
  (konvensi huruf kecil = push) sebelum ditulis; kalau replay gagal,
  ditulis file kosong — tidak pernah ada solusi ilegal.
- **Anggaran waktu**: total 50 detik untuk semua instance; tiap instance
  mendapat `min(sisa, max(2 dtk, 2 × sisa/jumlah tersisa))`. Kalau waktu
  habis, sisa instance ditulis kosong dan program keluar.

## Hasil test (harness `node tests/run_tests.mjs`, lokal)

Simulasi grader: 12 instance, 2 run (cek determinisme), replay independen
di harness (implementasi kedua, bukan kode `main.ts`).

| instance | kotak | hasil | push | move |
| --- | --- | --- | --- | --- |
| level00-solved | 1 | solved (file kosong) | 0 | 0 |
| level01-micro | 1 | **push optimal** | 1 | 1 |
| level02-two-box | 2 | **push optimal** | 2 | 9 |
| level03-three-box | 3 | **push optimal** | 8 | 29 |
| level04-four-box | 4 | **push optimal** | 10 | 37 |
| level05-corridor | 2 | **push optimal** | 6 | 42 |
| level06-room | 4 | **push optimal** | 24 | 144 |
| level07-five-box | 5 | **push optimal** | 13 | 49 |
| level08-tight | 3 | **push optimal** | 9 | 63 |
| level09-six-box | 6 | **push optimal** | 15 | 58 |
| deadlock-corner | 1 | unsolvable → file kosong | — | — |
| deadlock-2x2 | 4 | unsolvable → file kosong | — | — |

- **Determinisme: PASS** (run 1 vs run 2 byte-identik).
- **Waktu total: ~300 ms** untuk 12 instance (batas grader 60 detik).
- **Push-optimal level01–09** terverifikasi dua lapis: (1) teori A* —
  fase optimal selesai di semua level test; (2) implementasi verifier
  independen (`/tmp/verify-optimal.mjs`: heuristik sum-min saja, dead
  square sudut saja, heap biner) sepakat di semua 12 level — level06:
  24 push (5.977 node), level07: 13 push (16.317 node), level08: 9
  push (114 node), level09: 15 push (111.782 node).
- Edge case: `node main.ts` tanpa `/input` → exit 0 tanpa crash;
  level rusak (karakter tak dikenal) → file solusi kosong, exit 0.

### Bug yang ditemukan & diperbaiki saat testing

Aturan dead-square "segmen dinding tanpa target" versi pertama ternyata
**false positive**: kotak di `(3,3)` level06 ditandai mati padahal bisa
meluncur ke `(2,3)` lalu turun — karena segmen dindingnya TERBUKA di
satu ujung. Akibatnya level06 dan level08 (yang sebenarnya solvable)
dinyatakan unsolvable. Perbaikan: segmen dinding hanya mematikan kalau
**kedua ujungnya tertutup dinding** (kotak benar-benar terperangkap) dan
segmen tidak mengandung target. Setelah perbaikan, kedua level solved
(level06: 24 push, level08: 9 push). Pelajaran: aturan pruning harus
dibuktikan sound, bukan sekadar "kelihatan benar".

## Asumsi spek yang dipakai

1. Level memakai format **XSB klasik** (`# @ + $ * .`); baris pendek
   dipad dengan lantai.
2. Jumlah kotak == jumlah target; solusi = semua kotak di target.
3. Output memakai konvensi standar Sokoban: **huruf kecil = push,
   huruf besar = jalan kaki** (mis. `r` = dorong ke kanan, `R` = jalan
   ke kanan tanpa mendorong). Jumlah push untuk penilaian = jumlah huruf
   kecil.
4. Instance ditemukan dengan me-listing subdirektori `/input` (diurutkan);
   `INPUT_DIR`/`OUTPUT_DIR` hanya override untuk testing lokal, default
   tetap `/input` dan `/output` sesuai spek.
5. "Best" diasumsikan = push-optimal per instance; solver dioptimasi
   untuk itu (bukan untuk jumlah langkah jalan kaki minimal).

## Yang bisa / belum bisa

**Bisa:**

- Parse semua simbol XSB; level rusak ditangani tanpa crash.
- Push-optimal di level kecil–menengah (1–6 kotak) dalam milidetik.
- Deteksi level mustahil (sudut, 2x2, kotak beku, dead square) dengan cepat.
- Selalu menjawab semua instance dalam format (file kosong sebagai fallback).
- Deterministik pada instance yang selesai cepat.

**Belum bisa / batasan:**

- Level besar (10+ kotak, ruang terbuka luas) bisa kehabisan node/waktu —
  fallback-nya solusi weighted-A\* (suboptimal, partial credit) atau file
  kosong. Belum ada IDA\*, pattern database, atau deadlock table.
- Heuristik Hungarian hanya sampai 10 kotak; di atas itu memakai jumlah
  jarak minimum (lebih lemah).
- Determinisme tidak dijamin secara mutlak untuk instance yang memicu
  pemutus batas waktu (hasil bisa bergantung pada kecepatan mesin) —
  tetapi instance yang selesai jauh di bawah batas (kasus normal) 100%
  deterministik.
- Repo yang disubmit hanya berisi `main.ts` + README ini; harness test
  (`tests/`) tetap di salinan lokal.

## Menyesuaikan ke spek bounty (kalau ada revisi)

- Format input berbeda -> ubah `parseLevel` di `main.ts`.
- Format output berbeda -> ubah `pushesToMoves` (string solusi) dan
  pemeriksaan format di `main()`.
- Batas waktu/node berbeda -> ubah `TOTAL_BUDGET_MS`, `PHASE1_NODES`,
  `PHASE2_NODES`.
- Heuristik lebih kuat (mis. pattern database) -> ganti `heuristic`.
