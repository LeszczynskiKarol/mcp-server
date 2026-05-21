# Rekomendowane preferencje użytkownika Claude.ai (PL)

> Polska wersja. Angielska: [CLAUDE_PREFERENCES.md](./CLAUDE_PREFERENCES.md).

Wklej do **Settings → Profile → Personal preferences** w
[Claude.ai](https://claude.ai/settings/profile). Te reguły zapobiegają
najczęstszym marnotrawcom tokenów i cichym uszkodzeniom plików gdy Claude
pracuje na plikach na Twoim lokalnym dysku przez ten MCP serwer.

Dostosuj ustawienia językowe i ścieżki absolutne do własnego setupu.

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

- Liczenie problemu ≠ rozwiązywanie problemu. Jeśli łapiesz się na
  "around 35 quotes to escape", "roughly 5 file writes needed",
  "approximately 11KB total" — to są metryki strategii którą JESZCZE
  NIE ZACZĄŁEŚ wykonywać. Wybierz strategię, wykonaj pierwszy krok,
  liczy się tylko ile faktycznie zostało do zrobienia po tym kroku.
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

# Edycja istniejącego pliku >50KB (DECISION FIRST)

`write_file` mode=overwrite ma HARD_LIMIT 50KB. NIE próbuj go obejść
przez kreatywne workaroundy. Wybierz JEDNĄ z trzech ścieżek w ciągu
30 sekund. Liczenie cudzysłowów, planowanie ile patchy, "let me
reconsider" — to NIE jest praca, to oscylacja. Stop.

## Decyzja: ile zmienia się treści?

A) 1-5 surgical replacements, każdy <50 linii → READ-MODIFY-WRITE INLINE

Jedno `local_exec` z PowerShell:
$c = Get-Content -Raw -LiteralPath '<path>' -Encoding UTF8
$c = $c.Replace('<old1>', '<new1>')
$c = $c.Replace('<old2>', '<new2>')
[System.IO.File]::WriteAllText('<path>', $c,
(New-Object System.Text.UTF8Encoding $false))

Old/new stringi w tutaj-stringach @'...'@ (literal, tylko ' → '').
.Replace() jest literal — NIE regex, NIE escape special chars.
Po każdym .Replace() opcjonalnie:
if ($c -eq $prev) { throw "patch N didn't match" }
żeby wykryć failed match zamiast cichego no-op.

B) Zmiana >50% pliku lub pełny rewrite → CHUNKED WRITE

write_file mode=overwrite z pierwszym ~30KB.
write_file mode=append z kolejnymi ~30KB.
Patrz sekcja "Chunkowanie długich outputów".

C) Zmiana dodaje nowy tool/feature wymagający restartu procesu który
zerwie obecny czat (MCP server, dev server z hot reload tej rozmowy)
→ SPEC-THEN-FRESH-CHAT

write_file do `<repo>/CHANGES_PLAN.md` z dokładnymi blokami
old/new dla każdego patcha + uzasadnienie + restart procedure.
Powiedz: "spec zapisany, zrestartuj X i otwórz nowy czat — wykonam
wg planu". STOP. Nie próbuj edytować w obecnym czacie nawet jeśli
"jeszcze działa" — nowe toole i tak nie będą widoczne.

## Anty-patterns (NIGDY)

- File-pair approach: pisanie `_patches/old_1.txt`, `_patches/new_1.txt`,
  `apply.ps1` "żeby uniknąć escape'owania". To jest helper script.
  Tutaj-stringi PowerShella załatwiają escape'y bez żadnych plików.
- Base64 wrapper na patches "żeby uniknąć quoting". PowerShell tutaj-stringi.
- Re-encoding całego pliku przez base64+stdin "żeby ominąć 50KB limit".
  Limit jest dla overwrite, nie dla local_exec → bezpośredni zapis
  przez .NET WriteAllText nie ma tego limitu.
- "Najpierw zapiszę stary plik na dysk jako backup". Mam git.

## Sygnały że jesteś w decision paralysis (STOP natychmiast)

- 2+ razy "actually, let me reconsider" / "wait, a simpler approach"
  / "hmm, on the other hand"
- Liczysz ilość znaków do escape'owania w planowanej strategii
- Generujesz drugą wersję planu zanim wykonałeś pierwszą
- Rozważasz 3+ strategie dla TEJ SAMEJ operacji zapisu
- 5+ tool calli bez zapisu na dysk docelowy

Reakcja: wybierz A. Default jest A. Jeśli A nie pasuje (>5 patchy
albo każdy patch >50 linii), wybierz B. C tylko gdy explicit restart
risk dla obecnego czatu.

## Push-back zamiast workaroundu

Jeśli widzisz że zadanie wymaga rzeczy która zerwie obecną sesję
(restart MCP, restart dev servera od którego zależy ta rozmowa,
migracja DB w trakcie której nie odpowiadam) — PYTAJ ZANIM zaczniesz,
nie po 10 nieudanych próbach obejścia.

"Ta zmiana wymaga restartu X co zerwie nasz czat. Trzy opcje:
(1) zrobię teraz, restart, kontynuujesz w nowym czacie.
(2) zapiszę spec, zrobisz sam.
(3) odłóżmy do końca sesji. Co wolisz?"

# Edycja istniejącego pliku w repo

Jeśli plik JEST lokalnie (D:\repo\) → git pull + local edit (PS) + git push.
Jeśli plik TYLKO na GitHubie → git data API.

# Chain wszystko w jednym local_exec gdy fail-fast OK

cd /d <path> && git pull && powershell ... && git add . && git commit -m "..." && git push

# Windows paths w argumentach tool calls

Gdy w tool callu (write_file, local_exec, read, edit) podajesz ścieżkę
Windows w argumencie JSON, NIGDY nie pisz single backslash przed literą.

NIEPRAWIDŁOWE:
"path": "D:\temp_file.txt" ← \t = TAB w JSON!
"path": "D:\new\thing.txt" ← \n = LF, \t = TAB
"path": "D:\Users\Admin\..." ← \U może być Unicode escape

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

1. Pierwszy chunk: write_file mode="overwrite" do PLIKU SCRATCH w
   katalogu D:/mcp-server/tmp/ (np. D:/mcp-server/tmp/<task>_part.txt).
   Szkielet + sekcja 1. NIE zapisuj scratchy do D:/ root — sprzątanie tam
   nie istnieje, te pliki zostają wieczne.
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
