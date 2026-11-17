# Glyph Drawing Club+

**→ Usalo online: [ciogoh.github.io/gdc-plus](https://ciogoh.github.io/gdc-plus/)**

Ricostruzione di [glyphdrawing.club](https://glyphdrawing.club) (MIT, Heikki Lotvonen — [sorgente originale](https://github.com/hlotvonen/glyph-drawing-club)) con UI più pulita, scorciatoie extra ed export SVG pulito per Illustrator. Nessuna build: HTML + JS vanilla.

## Avvio in locale

```bash
python3 -m http.server 8765
```

Poi apri http://localhost:8765 (serve un server perché i font vengono caricati via fetch).

## Cosa cambia rispetto all'originale

- **Export SVG pulito**: niente `<svg>` annidati, niente rettangolo per ogni cella. Ogni forma è un tracciato separato con coordinate già trasformate, organizzato in gruppi layer → colore (`layer-1`…`layer-4`, `sfondo`). Tracciati composti solo per i buchi veri (es. celle invertite). Con una selezione bloccata (⇧S) si esporta solo quell'area; unità in px o mm (dai DPI).
- **Copia per Illustrator** (⌘⇧C): copia l'SVG negli appunti → ⌘V in Illustrator.
- Scorciatoie nuove: `[` `]` glyph prec./succ., `{` `}` ±10, `G` pennello, `T` scrittura, `Esc` deseleziona, `?` guida, ⌘S / ⌘O / ⌘E / ⌘⇧E, Shift+trascina per selezionare, rotella = pan, pinch = zoom.
- **Disegna la forma**: schizzi a mano libera (anche solo il contorno, o riempimenti sporchi) e compaiono subito i glyph più simili del font, raggruppati per forma con tutte le rotazioni, specchiature e inversioni; scegli con le frecce e piazzi con Q. Il confronto usa i contorni (chamfer matching) più la sovrapposizione delle aree, con riempimento pari/dispari dello schizzo.
- **Layer** in un pannello verticale classico: si parte da 2, se ne aggiungono fino a 16, si riordinano trascinandoli e ognuno ha la sua opacità (esportata come trasparenza del gruppo). I `.gdc` si salvano sempre con almeno 4 layer, così l'originale li apre ancora (file con più di 4 layer solo qui).
- Tutte le scorciatoie originali restano valide. I file `.gdc` sono compatibili in entrambe le direzioni.
