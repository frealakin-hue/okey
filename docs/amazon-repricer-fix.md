# Amazon Repricer Düzeltme Notu

Bu repo içinde PHP dosyaları bulunmadığı için doğrudan canlı dosyaları düzenleyemedim.
Aşağıdaki kod, istediğiniz mantığı **tek noktada** uygular:

- Fiyatım, rakibin sürekli 1 TL altına iner.
- Ama `target_price` (En Düşük Fiyat) altına **asla** düşmez.

## Önerilen Repricer Mantığı (cron_update_prices.php)

```php
<?php
require_once __DIR__ . '/bootstrap.php';
require_once __DIR__ . '/helpers/amazon_sp_api.php';

$amazon = new AmazonSpApi($config['amazon']);

$stmt = $pdo->query("SELECT * FROM products WHERE status='active' AND auto_reprice=1 AND stock_quantity > 0 AND asin != '' AND seller_sku != ''");
$products = $stmt->fetchAll(PDO::FETCH_ASSOC);

foreach ($products as $p) {
    $priceRes = $amazon->getCompetitivePricingByAsin($p['asin']);
    if (!$priceRes['success']) {
        continue;
    }

    $rakipFiyat = (float)$priceRes['lowest_price'];
    $benimFiyat = (float)$p['my_price'];
    $enDusukFiyat = (float)$p['target_price'];

    // 1 TL altına inme hedefi
    $hedefFiyat = round($rakipFiyat - 1.00, 2);

    // Alt limit koruması: asla en düşük fiyatın altına düşme
    if ($hedefFiyat < $enDusukFiyat) {
        $yeniFiyat = $enDusukFiyat;
    } else {
        $yeniFiyat = $hedefFiyat;
    }

    // Sadece değişiklik varsa gönder
    if (round($yeniFiyat, 2) !== round($benimFiyat, 2)) {
        $send = $amazon->submitPriceFeed($p['seller_sku'], $yeniFiyat);
        if ($send['success']) {
            $pdo->prepare("UPDATE products SET my_price = ?, amazon_lowest_price = ?, last_amazon_check = NOW() WHERE id = ?")
                ->execute([$yeniFiyat, $rakipFiyat, $p['id']]);

            echo "SKU {$p['seller_sku']} güncellendi: {$benimFiyat} -> {$yeniFiyat} (rakip: {$rakipFiyat})\n";
        }
    } else {
        // Fiyat değişmediyse bile rakip fiyatını güncel tut
        $pdo->prepare("UPDATE products SET amazon_lowest_price = ?, last_amazon_check = NOW() WHERE id = ?")
            ->execute([$rakipFiyat, $p['id']]);
    }
}
```

## Beklenen Davranış (Sizin Örnek)

- Fiyatım: `6700`
- Rakip: `6800`
- En Düşük: `6600`

Rakip `6690` olursa:
- Hedef = `6689` => **Fiyatım 6689 olur**

Rakip `6599` olursa:
- Hedef = `6598`
- Alt limit = `6600`
- **Fiyatım 6600'de kalır, daha fazla düşmez**

## Not

Sizde `target_price` alanı "en düşük fiyat" olarak kullanılıyor. İsterseniz alan adını `min_price` ile netleştirin ve kodu ona göre güncelleyin.
