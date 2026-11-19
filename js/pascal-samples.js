// Voorbeeldprogramma's voor de Pascal-compiler
export const PASCAL_SAMPLES = [
  {
    name: 'Hallo, wereld',
    description: 'Het kleinste programma: één regel tekst. Kijk ook naar de gegenereerde assembler.',
    source: `program Hallo;
begin
  writeln('Hallo, wereld! Groeten van de PDP-11.')
end.
`,
  },
  {
    name: 'Tafels',
    description: 'Een tafel van vermenigvuldiging met for-lussen. Met :4 druk je een getal af in 4 posities.',
    source: `program Tafels;
{ Een tafel van vermenigvuldiging van 1 t/m 10. }
var
  rij, kolom: integer;
begin
  write('   x');
  for kolom := 1 to 10 do
    write(kolom:4);
  writeln;
  for rij := 1 to 10 do
  begin
    write(rij:4);
    for kolom := 1 to 10 do
      write(rij * kolom:4);
    writeln
  end
end.
`,
  },
  {
    name: 'Raad het getal',
    description: 'Het programma bedenkt een getal tussen 1 en 100; jij raadt. Gebruikt readln, while en if.',
    source: `program RaadHetGetal;
{ Bedenkt een getal tussen 1 en 100. De computer heeft geen klok
  om toevallige getallen te maken, dus vragen we om een geluksgetal. }
var
  geheim, poging, beurten, geluk: integer;
begin
  write('Geef een geluksgetal: ');
  readln(geluk);
  { een eenvoudige rekenformule maakt er een "toevallig" getal van }
  geheim := abs((geluk * 37 + 11) mod 100) + 1;
  writeln('Ik heb een getal tussen 1 en 100 bedacht.');
  beurten := 0;
  poging := 0;
  while poging <> geheim do
  begin
    write('Jouw gok: ');
    readln(poging);
    beurten := beurten + 1;
    if poging < geheim then
      writeln('Hoger!')
    else if poging > geheim then
      writeln('Lager!')
  end;
  writeln('Goed geraden in ', beurten, ' beurten!')
end.
`,
  },
  {
    name: 'Zeef van Eratosthenes',
    description: 'Priemgetallen met een array van booleans: streep alle veelvouden weg.',
    source: `program Zeef;
{ De zeef van Eratosthenes: zet eerst alle getallen op "priem",
  streep dan de veelvouden van elk priemgetal weg. }
const
  MAX = 500;
var
  priem: array [2..500] of boolean;
  i, j, aantal: integer;
begin
  for i := 2 to MAX do
    priem[i] := true;
  i := 2;
  while i * i <= MAX do
  begin
    if priem[i] then
    begin
      j := i * i;
      while j <= MAX do
      begin
        priem[j] := false;
        j := j + i
      end
    end;
    i := i + 1
  end;
  aantal := 0;
  for i := 2 to MAX do
    if priem[i] then
    begin
      write(i:5);
      aantal := aantal + 1;
      if aantal mod 10 = 0 then writeln
    end;
  writeln;
  writeln(aantal, ' priemgetallen tot ', MAX)
end.
`,
  },
  {
    name: 'Recursie: faculteit',
    description: 'Een functie die zichzelf aanroept. Bij 8! past de uitkomst niet meer in 16 bits: kijk wat er dan gebeurt.',
    source: `program Faculteit;
{ n! = 1 * 2 * 3 * ... * n. Een integer op de PDP-11 heeft 16 bits
  en gaat maar tot 32767; daarom stopt het programma bij 8! met een
  foutmelding over overloop. }
var
  i: integer;

function fac(n: integer): integer;
begin
  if n <= 1 then
    fac := 1
  else
    fac := n * fac(n - 1)    { de functie roept zichzelf aan }
end;

begin
  for i := 1 to 10 do
    writeln(i:2, '! = ', fac(i))
end.
`,
  },
  {
    name: 'Torens van Hanoi',
    description: 'Het klassieke recursieve puzzeltje: verplaats de schijven van paal A naar C.',
    source: `program Hanoi;
{ Verplaats n schijven van paal 'van' naar paal 'naar'.
  Er mag nooit een grote schijf op een kleine liggen. }
var
  zetten: integer;

procedure verplaats(n: integer; van, naar, via: char);
begin
  if n > 0 then
  begin
    verplaats(n - 1, van, via, naar);
    zetten := zetten + 1;
    writeln('Schijf ', n, ' van ', van, ' naar ', naar);
    verplaats(n - 1, via, naar, van)
  end
end;

begin
  zetten := 0;
  verplaats(4, 'A', 'C', 'B');
  writeln(zetten, ' zetten')
end.
`,
  },
  {
    name: 'Sorteren',
    description: 'Bubble sort met een array als var-parameter en een procedure om twee getallen te verwisselen.',
    source: `program Sorteren;
const
  N = 12;
type
  rij = array [1..12] of integer;
var
  getallen: rij;
  i: integer;

procedure wissel(var a, b: integer);
var
  hulp: integer;
begin
  hulp := a;
  a := b;
  b := hulp
end;

procedure druk(var r: rij);
var
  k: integer;
begin
  for k := 1 to N do
    write(r[k]:5);
  writeln
end;

procedure sorteer(var r: rij);
var
  k, m: integer;
begin
  for k := N - 1 downto 1 do
    for m := 1 to k do
      if r[m] > r[m + 1] then
        wissel(r[m], r[m + 1])
end;

begin
  { vul de rij met "willekeurige" getallen }
  getallen[1] := 7;
  for i := 2 to N do
    getallen[i] := (getallen[i - 1] * 29 + 17) mod 101;
  write('Voor:  ');
  druk(getallen);
  sorteer(getallen);
  write('Na:    ');
  druk(getallen)
end.
`,
  },
];
