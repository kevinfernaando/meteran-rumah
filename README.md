# Meteran Rumah

Track your home electricity and EV charging in kWh and Rupiah.

- Log home usage as kWh used or as meter readings (the app works out the difference).
- Prepaid token meters (prabayar): log the remaining kWh (sisa) and each token top-up; usage is worked out as last remaining + top-ups − current remaining, and recalculated if you delete an entry.
- Log EV charging sessions at home.
- See each month split into household and EV charging at home, with costs at your PLN tariff, PPJ and the home-charging night discount.
- Charts for the last 6 months and for EV charging day by day.

## Your data

Everything is saved in your browser (localStorage) on the device you use. Nothing is sent to a server.
Use **Export backup** and **Import backup** to keep a copy or move your log to another device.

## Run locally

It's a single static page. Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

## Tests

Browser tests use Node's test runner and Playwright with Chromium:

```bash
npm test
```

## Tariff defaults

Presets are PLN non-subsidised household rates (for example Rp 1.444,70/kWh for 1.300–2.200 VA). Check them against your bill or token receipt and edit them in **Tariff settings** if they've changed.
