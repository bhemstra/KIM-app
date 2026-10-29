# Junior Computer als desktop-app

Dezelfde emulator als `junior.html`, verpakt met [Tauri](https://tauri.app) als
app voor Windows en macOS. De app gebruikt de ingebouwde webweergave van het
systeem (WebView2 op Windows, WebKit op macOS) en is daardoor klein.
Programma's opslaan (*Bestanden → Als .ptp / .bin*) gebruikt het gewone
opslagvenster van het systeem.

## Downloaden

Elke push die de emulator of deze map wijzigt, start de workflow
**Junior desktop-apps** in GitHub Actions. Open de laatste run onder *Actions*
en download onder *Artifacts*:

- `junior-computer-windows`: installatieprogramma (`.exe`) en `.msi`
- `junior-computer-macos`: `.dmg` voor Intel- en Apple Silicon-Macs

De apps zijn niet ondertekend met een betaald ontwikkelaarscertificaat:

- **Windows**: SmartScreen kan waarschuwen. Kies *Meer info* → *Toch uitvoeren*.
- **macOS**: sleep de app naar *Programma's*. Bij de eerste keer openen meldt
  macOS dat de ontwikkelaar onbekend is. Open dan *Systeeminstellingen →
  Privacy en beveiliging* en kies *Open toch*.

## Zelf bouwen

Nodig: Node.js 22 en Rust (via [rustup](https://rustup.rs)), plus de
[systeemvereisten van Tauri](https://tauri.app/start/prerequisites/).

```sh
cd desktop
npm ci
npx tauri dev     # starten om te testen
npx tauri build   # installatiebestand voor het huidige systeem
```

Het icoon staat in `app-icon.png`; `npm run icons` maakt daar de iconen in
`src-tauri/icons/` van.
