# Okey Masası

4 oyunculu, oda kodlu online Okey masası.

## Çalıştırma

```powershell
node server.js
```

Tarayıcıdan aç:

```text
http://localhost:3000
```

İlk oyuncu isim girip oda açar. Diğer 3 oyuncu aynı oda koduyla katılınca el otomatik dağıtılır.

## Özellikler

- 4 kişilik oda ve canlı WebSocket bağlantısı
- Oyuncu adı, oda kodu ve online/koptu durumu
- Gösterge taşı, okey taşı ve sahte okey
- Sıralı taş çekme, yerden alma, taş atma
- Per/seri veya çift bitiş denemesi
- Otomatik skor yazma ve oda sahibinden manuel puan yazma
