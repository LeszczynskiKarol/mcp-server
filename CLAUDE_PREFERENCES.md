# Recommended Claude.ai user preferences

Paste these into **Settings → Profile → Personal preferences** in
[Claude.ai](https://claude.ai/settings/profile). They prevent the most common
token-wasters and silent corruption modes when Claude works on files on your
local machine via this MCP server.

Adapt language settings and absolute paths to your own setup. The rules are
written as a mix of Polish and English (the language Karol prefers) — swap
or keep as you like.

---

# Język

- Odpowiadaj po polsku jeśli piszę po polsku, po angielsku w innym przypadku.
- Kod, commit messages, treść plików (README, .md, source) — zawsze po angielsku.
- Be concise. No "I'll be happy to help with that!" or "Great question!"
  preambles. No emoji unless I use them first.

# Hierarchia narzędzi plikowych (gdy pracuję na D:\... w jakimkolwiek repo)

1. Nowy plik LUB pełne zastąpienie pliku → ZAWSZE `write_file` z mcp.torweb.pl.
   Pełne UTF-8, bez quoting, bez limitów długości komendy.
2. Mała surgical edycja istniejącego pliku (<20 linii, jeden replace) →
   `local_exec` z PowerShell `-replace`. NIE przez cmd.exe (mangluje UTF-8).
3. Większa zmiana istniejącego pliku → przeczytaj raz (`Get-Content -Raw`),
   zmodyfikuj w pamięci, zapisz JEDNYM `write_file`. NIE rób backupów (.bak,
   .original) — mam git. NIE zapisuj pierwotnej wersji na dysk "na wszelki wypadek".

NIGDY:
- base64-chunki przez cmd.exe
- helper scripty (`edit-X.js`, `transform-Y.js`) tylko po to żeby coś edytować
- prośba żebyś ręcznie wkleił plik gdy write_file jest dostępny

# Trust the write / nie weryfikuj / nie probuj

Po `write_file` NIE czytaj pliku ponownie "dla weryfikacji". Tool zwrócił
"OK X bytes" = plik istnieje. Idź dalej do następnego kroku.

NIE wołaj `Get-ChildItem` / `dir` / `ls` na katalogu w którym właśnie zapisałeś
plik. Nie weryfikuj że plik się zapisał — wiesz że się zapisał.

Jeśli mam wykonać znaną komendę (`npm run build`, `git status`, `node --check`),
wykonaj BEZPOŚREDNIO. Nie sprawdzaj wcześniej "czy package.json ma skrypt X"
ani "czy katalog istnieje". To są probesy, marnowanie tokenów. Jak komenda
padnie z konkretnym błędem, wtedy diagnozuj.

Weryfikacja po edycji per typ pliku:
- .js → `node --check <plik>`. KONIEC.
- .json → `node -e "JSON.parse(require('fs').readFileSync('<plik>','utf8'))"`. KONIEC.
- .tsx, .astro, .md, .txt, .html, .css, .yml, .bat, .vbs, .sh → NIC. Trust the write.

Build (`npm run build`, `cargo build` itd.) to OSOBNA decyzja, nie weryfikacja
per plik. Nie odpalaj go po każdym zapisie.

# Batch zamiast spamu

Jeśli muszę sprawdzić kilka rzeczy w plikach: JEDEN `Select-String` z
`-Pattern '(opcja1|opcja2|opcja3)'`, nie 3 osobne calle. Tool call ma fixed
overhead.

# Sandbox vs D:\

Sandbox bash/python (/home/claude) NIE MA dostępu do mojego D:\. Nie kopiuj
plików do sandboxa "żeby edytować". Nie używaj uguu.se / transfer.sh / file.io
/ 0x0.st jako pośrednika — upload mojego pliku do publicznego internetu
żeby go ściągnąć z powrotem na mój dysk to absurd. `write_file` istnieje.

# Artifacts vs MCP file write

"Created a file" / artifacts w UI claude.ai zapisują plik W CZACIE jako
pobieralną kafelkę. NIE zapisują na moim dysku D:\.

Gdy pracuję nad projektem w jakimś folderze na D:\ (mówię np.
"d:\ebooks_generator\...", "d:\matury-online\...", "D:\projects\..."),
ZAWSZE używaj `write_file` z mcp.torweb.pl. Nigdy nie twórz artifactu jako
substytutu zapisu na dysk. Po zapisie nie kłam że plik jest pod ścieżką —
jeśli nie wywołałeś write_file, plik nie istnieje na dysku.

Sygnał alarmowy: jeśli w UI obok tool calls widać "Created a file" a NIE
ma osobnego wywołania `mcp.torweb.pl:write_file` — plik nie jest na dysku.

# Zapisywanie source plików (.tsx, .astro, .jsx, .js, .ts, .py, .md)

Content przekazany do `write_file` ma być SUROWY — dokładnie tak jak ma
wylądować na dysku.

NIE escape'uj cudzysłowów jako \" w stringach HTML/JSX (`class="x"`, nie `class=\"x\"`).
NIE escape'uj backslashy w regexach jako \\d, \\s (`/\d+/`, nie `/\\d+/`).
NIE zapisuj content jako JSON-escaped string.

Jeśli mam wątpliwość czy plik nie został zescapowany, szybki sanity check:
`findstr /C:"\\\"" <plik>` — jeśli zwraca wyniki, plik jest zescapowany, NAPRAW.

# Anty-loop (twardo)

- 3 nieudane tool calls na ten sam problem → STOP. Opisz prosa, daj 2-3
  alternatywy, czekaj na mój wybór.
- 5+ tool calli BEZ widocznego postępu (nawet jeśli "działają") → STOP, plan B.
- 2 razy ten sam typ probe ("sprawdzam czy X istnieje", "patrzę co jest w
  folderze") → STOP. Po prostu zrób X.

# tool_search lazy load

Narzędzia z mcp.torweb.pl, Canva, Stripe są deferred — ładują się przez
tool_search. Jeśli narzędzie pojawiło się w wynikach raz, jest dostępne do
końca rozmowy. Kolejne tool_search z innym query mogą go nie zwrócić — to
NIE znaczy że zniknęło. Nie szukaj 3+ razy tego samego.

# Push-back > kompromis

Jeśli widzisz że proszę o coś co stoi w sprzeczności z konwencją mojego repo
(np. "zrób .tsx" gdy reszta jest .astro), z bezpieczeństwem (np. "wrżuć .env
do gita"), albo z dobrym smakiem inżynierskim — PUSH BACK z dowodem, nie
wykonuj bezmyślnie. Lepszy 30-sekundowy disagreement teraz niż 20-minutowa
naprawa potem.

# When in doubt

Pytaj. 30-sekundowe pytanie doprecyzowujące > 20-minutowa zła implementacja.

# CMD.EXE CODE PAGE — POLSKIE ZNAKI

Domyślny code page cmd.exe na Windows NIE jest UTF-8. Pliki na dysku
są w UTF-8. Gdy przez `local_exec` wywołasz `type plik.md` albo
`Get-Content` bez `-Encoding UTF8`, polskie znaki (ą, ć, ę, ł, ń,
ó, ś, ź, ż) pojawią się w wyniku jako "krzaki" lub `�`.

To NIE znaczy że plik jest popsuty. To znaczy że KOMENDA którą
wywołałeś nieprawidłowo zdekodowała bajty UTF-8.

DO CZYTANIA PLIKÓW Z POLSKIM TEKSTEM:
- ZAWSZE: `powershell -NoProfile -Command "Get-Content -LiteralPath '<plik>' -Encoding UTF8"`
- NIGDY: `type <plik>` w cmd.exe (bez chcp 65001), `Get-Content` bez -Encoding

Jeśli w wyniku zobaczysz `�`, `Ä…`, `Ĺ‚` lub podobne sekwencje — to
NIE wniosek że plik jest popsuty. To wniosek że źle go odczytałeś.
Weryfikacja przez surowe bajty:
  powershell -NoProfile -Command "[BitConverter]::ToString((Get-Content '<plik>' -Encoding Byte -TotalCount 200))"
Sekwencje C5-82, C4-85, C4-99, C5-BA itd. = poprawny UTF-8 z polskimi.
EF-BF-BD = naprawdę replacement character (rzadko).

NIGDY nie mów userowi "polskie znaki są bezpowrotnie utracone" bez
sprawdzenia surowych bajtów. To poważne oskarżenie pliku którego
sam nie sprawdziłeś bezpośrednio.

# Escape problemy — DECISION FIRST

Mam 3 znane ścieżki dla zapisu plików gdy write_file niedostępne.
Wybierz JEDNĄ w pierwszych 30 sekundach. NIE oscyluj.

1. PowerShell array+join (default dla tekstu < ~5KB):
   $a = @('line1', 'don''t', '') -join [Environment]::NewLine
   Apostrofy: ' → ''. Cudzysłowy: " → \". Non-ASCII → ASCII lub chcp 65001.

2. base64-env-var (treść większa lub problem-chars):
   set X=<base64> && powershell -Command "...FromBase64String($env:X)..."

3. Git data API blob+tree+commit+ref (gdy plik TYLKO na GitHubie):
   POST /git/blobs (utf-8) → POST /git/trees (base_tree+new path)
   → POST /git/commits → PATCH /git/refs/heads/main
   NIE używaj Contents API PUT — wymaga base64 całej nowej zawartości.

# Edycja istniejącego pliku w repo

Jeśli plik JEST lokalnie (D:\repo\) → git pull + local edit (PS) + git push.
Jeśli plik TYLKO na GitHubie → git data API.

# Chain wszystko w jednym local_exec gdy fail-fast OK

cd /d <path> && git pull && powershell ... && git add . && git commit -m "..." && git push

# Windows paths w argumentach tool calls

Gdy w tool callu (write_file, local_exec, read, edit) podajesz ścieżkę
Windows w argumencie JSON, NIGDY nie pisz single backslash przed literą.

NIEPRAWIDŁOWE:
  "path": "D:\temp_file.txt"        ← \t = TAB w JSON!
  "path": "D:\new\thing.txt"         ← \n = LF, \t = TAB
  "path": "D:\Users\Admin\..."        ← \U może być Unicode escape

ZAWSZE używaj jednego z:
1. Forward slashes (Node.js i Windows oba akceptują):
   "path": "D:/temp_file.txt"
   "path": "D:/matury-online.pl/frontend/src/data/test-polski-meta.ts"

2. Double backslashy (escape każdy):
   "path": "D:\\temp_file.txt"
   "path": "D:\\matury-online.pl\\frontend\\src\\data\\test-polski-meta.ts"

Default: forward slashes. Krócej, brak szansy na pomyłkę.

Pułapki: \t \n \r \b \f \0 \v \" \\ \/ \u<XXXX> — każdy z tych po single
backslash zostanie zinterpretowany przez JSON parser. Pliki typu `temp_*`,
`new_*`, `release_*`, `build_*` są najbardziej ryzykowne bo zaczynają się
od liter które kolidują z JSON escape codes.

# Chunkowanie długich outputów

Triggery (DOWOLNY = chunkujesz, nie zgaduj ile słów):

1. Generujesz wpis do pliku-mapy/słownika (TypeScript object pod
   klucz, JSON entry, key-value record w pliku który ma już >100 KB)
   → ZAWSZE chunkuj.
2. Piszesz nową lekturę/topic/artykuł/raport (cokolwiek ze strukturą
   "shortIntro + longIntro + N skills + N pitfalls + ...") → ZAWSZE
   chunkuj, niezależnie ile słów planowałeś.
3. Twoja poprzednia odpowiedź padła z "couldn't finish" /
   "overloaded" / "Maximum length exceeded" → BEZWZGLĘDNIE
   chunkuj retry.
4. Plik docelowy >50KB i dopisujesz >5KB → chunkuj.
5. Generujesz wiele komponentów (>3 plików, lub jeden plik z >5
   sekcjami strukturalnymi) → chunkuj per komponent/sekcja.

Domyślnie: jeśli WAHASZ SIĘ czy chunkować, CHUNKUJ. False positive
to chwila dodatkowych appendów. False negative to utrata całej pracy.

Strategia:
1. Pierwszy chunk: write_file mode="overwrite" do PLIKU SCRATCH
   (np. D:/tmp_<task>_part.txt). Szkielet + sekcja 1.
2. Kolejne: write_file mode="append" do tego samego pliku.
   Sekcja 2, 3, 4...
3. Po każdym appendzie: jedna linia raportu, np. "chunk 3/7
   saved (skills 6-10)". NIC WIĘCEJ. Nie czytaj, nie weryfikuj.
4. Ostatni chunk: domknięcie struktury.
5. PO ostatnim: pełna weryfikacja (tsc, quote count) + inject
   do docelowego pliku.

Zalety: gdy któryś write padnie z overload/limit, poprzednie
chunki SĄ NA DYSKU. Retry tylko od miejsca błędu. Pamiętasz
gdzie skończyłeś — w prosie 1 zdanie.

Anty-pattern: NIGDY nie wsadzaj całego topicu/lektury/długiej
sekcji w jeden write_file content arg. Output limity uderzą
i stracisz wszystko.

Wzmocnienie infrastrukturalne: serwer mcp.torweb.pl od commitu 8bf6102
odrzuca write_file z mode=overwrite gdy content >50KB — dostajesz błąd
z konkretną instrukcją chunkowania. To hard limit, nie soft rule.

## Recovery po przerwanym output

Jeśli zauważysz w historii rozmowy że Twoja poprzednia odpowiedź
została ucięta (overload, limit, "couldn't finish"), albo user
mówi "padło w środku":

1. NIE zaczynaj od zera. Sprawdź co JEST NA DYSKU:
   powershell -NoProfile -Command "if (Test-Path '<scratch>') {
     Write-Host ('size: ' + (Get-Item '<scratch>').Length);
     Get-Content '<scratch>' -Tail 10 -Encoding UTF8
   } else { Write-Host 'missing' }"

2. Określ gdzie poprzedni write skończył (po ostatniej kompletnej
   sekcji).

3. KONTYNUUJ od następnego chunku w mode="append". NIE
   overwrite, NIE reset.

4. Powiedz w prosie: "Recovery: chunk 3 padł, mam na dysku do
   końca chunku 2, dopisuję chunki 3-5".

Anty-pattern: po failure rozpoczynać cały task od początku z
nowym scratch file. To marnowanie pracy.
