# iPhone-app for elev

Dette prosjektet bruker Capacitor til å pakke elevsiden som en iOS-app.

## Åpne i Xcode

Kjør:

```bash
npm run ios:open
```

Dette bygger webfilene for elevappen, synker dem inn i `ios/`, og åpner Xcode-prosjektet.

Hvis Xcode-kommandolinjen peker på Command Line Tools i stedet for Xcode, sett riktig Xcode i Terminal:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

## Første kjøring på iPhone

1. Åpne `ios/App/App.xcodeproj` i Xcode, eller kjør `npm run ios:open`.
2. Velg target `App`.
3. Gå til `Signing & Capabilities`.
4. Velg Apple Developer-teamet ditt.
5. Koble til iPhone.
6. Velg telefonen som device.
7. Trykk Run.

## App-ID

Appen bruker bundle id:

```text
com.hrafnir.rebuselev
```

Endre denne i `capacitor.config.json` og Xcode dersom appen skal publiseres under et annet navn eller en annen organisasjon.

## Tillatelser

Appen har iOS-tekster for:

- posisjon, for å åpne poster ved geofence
- kamera, for bilde/video-innlevering
- bildebibliotek, for å velge bilder/video
- mikrofon, for lyd/video-innlevering

## Viktig

iOS-appen bruker samme Supabase-backend som webappen. Når du endrer elevsiden, kjør alltid:

```bash
npm run ios:sync
```

før du bygger i Xcode.
