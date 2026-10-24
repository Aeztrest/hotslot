# hotslot

[English](README.md) · **Türkçe**

Monad'ın işlemleri paralel çalıştırmasını engelleyen storage slot'larını bulur, bunun paralelliğe maliyetini
ölçer ve her çakışmanın kaçınılabilir olup olmadığını söyler.

```
$ pnpm hotslot scan --blocks 500

Monad mainnet: parallelism lost to shared state
blocks 116,171,670–116,172,169 · 499 blocks · 6,672 txs · chain 143

  conflicted txs        42% had to wait on an earlier tx in the same block
  parallelism possible  13.37×
  parallelism actual    3.20×
```

## Problem

Monad bir bloktaki işlemleri paralel çalıştırır. Her işlemi iyimser (optimistic) olarak bloğun başındaki
state üzerinde çalıştırır, sonuçları ise blok sırasıyla kaydeder. 7. işlem, 3. işlemin yazdığı bir storage
slot'unu okuduysa eski bir değerle çalışmış demektir: sonucu atılır ve 3. işlemden sonra yeniden çalıştırılır.
Yani 7. işlem, 3. işlemden önce bitemez.

Bir bloktaki bu beklemeleri takip edince bir bağımlılık grafiği çıkar. Grafikteki en uzun zincir, kaç çekirdek
olursa olsun bloğun ihtiyaç duyduğu en az sıralı adım sayısıdır. Her çağrıda `totalCount += 1` yapan bir kontrat,
kendisine gelen işlemlerden oluşan bir bloğu tek bir zincire çevirir: işlemler birer birer çalışır.

Bunu kimse fark etmez, çünkü tasarım gereği görünmez. Ethereum işlemleri sırayla çalıştırdığı için global bir
sayacın orada hiçbir maliyeti yoktur ve Monad'daki kontratların çoğu Ethereum için yazılmıştır. Monad tam EVM
uyumluluğunu korur: beyan edilecek bir erişim listesi yoktur (Solana ise işlemin dokunduğu her hesabı önceden
yazdırır), hata yoktur, ekstra gas yoktur, uyarı yoktur. Paralellik sessizce kaybolur.

Mainnet'te art arda 499 blokta (116,171,670–116,172,169):

| | |
|---|---|
| aynı bloktaki başka bir işlemi beklemek zorunda kalan işlemler | %42 |
| mümkün olan paralellik (blok başına ortalama işlem) | 13.37× |
| gerçekleşen paralellik (Σ işlem ÷ Σ en uzun zincir) | 3.20× |
| sadece kontrat storage çakışmaları olsaydı | 3.25× |
| sadece aynı hesabın sıralaması olsaydı (bir gönderici, birden çok işlem) | 4.35× |

Asıl sınır storage çakışmaları, ve kontrat tasarımının kontrol ettiği kısım da bu. En kötü 6 kontratın storage
çakışmaları kaldırılsaydı, aynı bloklarda storage kaynaklı paralellik 3.25×'ten 10.68×'e çıkardı. Bu bir üst
sınırdır: kök neden analizinin kaçınılmaz diye sınıflandırdığı çakışmaları da kaldırır.

## hotslot ne yapar

1. **Okuma/yazma setleri.** Bloktaki her işlem için geth'in `prestateTracer`'ı ile `debug_traceBlockByNumber`,
   işlemin dokunduğu her slot'u (varsayılan mod) ve değiştirdiği her slot'u (diff modu) verir. SSTORE da okuma
   sayılır, çünkü gas maliyeti slot'un mevcut değerine bağlıdır.
2. **Bağımlılık grafiği.** Her okuma, o slot'a en son yazan önceki işleme bağlanır. En uzun yol bloğun sıralı
   maliyetidir; işlem sayısı ÷ en uzun yol, bloğun paralelliğidir.
3. **Sorumluluk dağıtımı.** Her slot ve her kontrat için grafik o olmadan yeniden hesaplanır. Kontratlar çoğu
   zaman *birlikte* sıcaktır (iki işlem hem bir router'ın hem bir vault'un slot'larını paylaşır), bu yüzden
   "bunları düzeltsek ne olurdu" sayıları açgözlü (greedy) yöntemle hesaplanır: her adımda en çok fayda
   sağlayan kontrat eklenir.
4. **Replay ile kök neden.** En sıcak slot'lar için örnek işlemler, dahil oldukları blok üzerinde
   `debug_traceCall` ile yeniden çalıştırılır. O işlemin ve sonrakilerin yazdığı her şey state override'larıyla
   geri sarılır, böylece her replay işlemin zincirde gördüğü state'in birebir aynısını görür. Bir replay ancak
   işlemin zincirdeki storage yazımlarını birebir üretiyorsa kullanılır. Ardından sadece sıcak slot'un değeri
   değiştirilir ve etkiler karşılaştırılır:

   | sonuç | anlamı | kaçınılabilir mi |
   |---|---|---|
   | `unused` | değeri değiştirmek hiçbir şeyi değiştirmiyor | evet: okumayı kaldır |
   | `overwrite` | eski değer kullanılmıyor (`lastCaller = msg.sender`) | evet: kullanıcı başına storage ya da event |
   | `accumulator` | işlem sabit bir delta ekliyor ve başka hiçbir şey ona bağlı değil (`total += x`) | evet: shard'la ya da event'lerden türet |
   | `guard` | değer sadece işlemin revert edip etmeyeceğini belirliyor (bir tavan, bir eşik) | genellikle hayır |
   | `dependent` | başka yazımlar ya da transferler bu değerden hesaplanıyor (rezervlerden fiyat) | hayır: sadece batching yardımcı olur |

5. **Deploy etmeden önce.** `hotslot simulate` bir kontratı yerel bir anvil zincirine deploy eder, N kullanıcının
   onu aynı blokta çağırmasını sağlar ve aynı analizi çalıştırır. Slot'lar Solidity storage layout'undan
   isimlendirilir.

| 64 kullanıcı, tek blok | slot başına | sayfa başına (MIP-8) | bulunan sıcak slot'lar |
|---|---|---|---|
| `QuestNaive`: global `totalCheckIns`, `lastPlayer`, `lastCheckInAt` | 1.00× | 1.00× | `totalCheckIns` accumulator, `lastPlayer` ve `lastCheckInAt` overwrite: hepsi kaçınılabilir |
| `QuestSharded`: toplam, adrese göre seçilen `uint256[64]` shard'larında | 21.3× | 1.00× | shard çakışmaları; sayfa başına bakınca 64 shard'ın hepsi sayfa 0'da |
| `QuestShardedMap`: aynı shard'lar bir `mapping`'de | 21.3× | 21.3× | sadece shard çakışmaları |
| `QuestFixed`: oyuncu başına struct, toplamlar event'lerden türetiliyor | 64.0× | 64.0× | yok |
| `MiniPool`: constant-product havuz | 1.00× | 1.00× | `reserveMon`, `reserveToken`: dependent, kaçınılmaz |

Havuz bilerek eklendi: naif quest kadar sıralı çalışıyor ve hotslot, storage düzeniyle ilgili hiçbir değişikliğin
bunu düzeltemeyeceğini doğru şekilde raporluyor.

## Slot başına mı, sayfa başına mı (MIP-8)

[MIP-8](https://mips.monad.xyz/MIPs/MIP-8), storage'ı ardışık 128 slot'luk sayfalara böler (`sayfa = slot >> 7`).
Sayfa; disk I/O'nun, state commitment'ın ve SLOAD/SSTORE gas'ının birimidir. MIP-8, paralel execution'ın
çakışmaları slot başına mı sayfa başına mı tespit ettiğini söylemiyor, bu yüzden hotslot ikisini de raporlar.

Çakışmalar sayfa başınaysa, aynı sayfadaki *farklı* slot'lara yazan iki işlem yine birbirini bekler. Buna false
sharing denir; iki CPU çekirdeğinin aynı cache line'daki farklı değişkenlere yazması gibi. Yukarıdaki mainnet
aralığında paralellik slot başına 3.20×, sayfa başına 3.18×; sayfa seviyesindeki 4227 beklemenin 90'ı (%2) false
sharing. Bugünkü mainnet'te bu soru toplamı pek değiştirmiyor: sıcak kontratlar zaten *aynı* slot'larda çakışıyor.

Simülasyonlar bunun kontrat tasarımı için neden önemli olduğunu gösteriyor. `QuestSharded` sayacını bir
`uint256[64]`'e bölüyor: ardışık 64 slot, hepsi sayfa 0'da. Slot başına bu 21× sağlıyor; sayfa başına ise her shard
çakışıyor ve sonuç 1×. `QuestShardedMap` aynı shard'ları, girdileri farklı sayfalara hash'lenen bir mapping'de
tutuyor ve her iki durumda da 21×'te kalıyor. İki modelde de geçerli tavsiye: shard'ları dizilerle ya da yan yana
değişkenlerle değil, mapping'lerle yap.

MIP-8'in gas modeli ise ters yöne çekiyor. İşlemde daha önce dokunulmuş bir sayfadaki diğer slot'lar warm ve
ucuz, yani sıcak veriyi tek bir sayfaya toplamak gas tasarrufu sağlarken çakışmaları da yoğunlaştırıyor.

## Çalıştırma

Gereksinimler: Node 22.18+ (TypeScript'i doğrudan çalıştırır), pnpm ve `simulate` için [Foundry](https://getfoundry.sh).

```sh
pnpm install

# son mainnet bloklarını analiz et (debug_traceBlockByNumber ve debug_traceCall sunan her RPC çalışır)
pnpm hotslot scan --blocks 500 --out data/mainnet.json

# tek bir bloğu açıkla: kritik yol adım adım ve her sıcak slot'un neden sıcak olduğu
pnpm hotslot block 116172098 --probe 3

# bir kontratı deploy etmeden önce simüle et
pnpm hotslot simulate contracts/scenarios/quest-naive.json

# data/ altındaki her şey için dashboard
pnpm dashboard

pnpm test        # grafik, sorumluluk dağıtımı ve kök neden sınıflandırması için birim testleri
pnpm typecheck
```

Dashboard statik bir sitedir. `vercel.json` onu repo kökünden build eder (`pnpm --filter dashboard build`, çıktı
`apps/dashboard/dist`) ve `data/` altındaki raporları içine koyar. Repoyu Vercel'a olduğu gibi import etmek
yeterli; environment variable gerekmez.

Bir senaryo; `contracts/src` altındaki bir kontratı, kullanıcı sayısını ve her kullanıcının yapacağı çağrıyı
belirten küçük bir JSON dosyasıdır (argümanlardaki `"$user"`, çağıranın adresiyle değiştirilir). Bkz.
`contracts/scenarios/`.

## Yapı

```
packages/core     analiz motoru: tracing, bağımlılık grafiği, sorumluluk dağıtımı, replay probe, etiketler
packages/cli      hotslot scan / hotslot block / hotslot simulate
contracts         demo kontratlar (Foundry) ve simülasyon senaryoları
apps/dashboard    data/ altındaki JSON raporları üzerinde React dashboard
data              üretilmiş raporlar
```

## İddia etmedikleri

- Paralellik değeri, sınırsız çekirdek ve eşit maliyetli işlemler varsayılarak veri bağımlılıklarının koyduğu bir
  üst sınırdır. Monad'ın execution motorunun ölçümü değildir; gerçek hızlanma çekirdek sayısına, işlem maliyetine
  ve state I/O'suna da bağlıdır. Monad'da yeniden çalıştırma ucuzdur çünkü okumalar cache'lenir; buradaki maliyet
  yeniden çalıştırmanın kendisi değil, bekleme zinciridir.
- Düz bir `BALANCE` okuması tracer'da görünmez, bu yüzden bakiye çakışmaları sadece iki işlem de bakiyeyi
  değiştirdiğinde sayılır. Hesap seviyesindeki çakışmalar uydurulmak yerine eksik sayılır.
- Kök neden, örneklenen işlem başına belirlenir (varsayılan olarak slot başına 3); en kısıtlayıcı sonuç kazanır.
  İki pertürbasyon denenir (+1 ve +0x1234567); sınırından uzak bir guard `unused` gibi görünebilir.
- Monad'ın execution motorunun çakışma tespitinde hangi birimi kullandığı MIP-8'de belirtilmemiştir; ana değerler
  slot başına olanlardır, sayfa başına değerler diğer durumu gösterir.
- Monad sistem işlemleri (gas = 0) ve staking precompile'ı blokta çalıştıkları için grafikte yer alır ama replay
  edilmezler: bir precompile'ın storage'ını override etmek hiçbir şey kanıtlamaz.

## Sırada ne var

- **CI kontrolü**: simülasyonu pull request'te çalıştırıp, bir değişiklik paralellik skorunu düşürürse PR'ı
  başarısız saymak; bugün gas snapshot'larının çalıştığı gibi.
- **Canlı indeks**: sürekli tarayıp kontrat başına geçmiş tutmak, böylece bir protokol hangi sürümünün onu sıcak
  noktaya çevirdiğini görebilir.
- **Mainnet slot'larına isim**: doğrulanmış kontratların storage layout'larını (Sourcify) çekip slot'ları
  simülatördeki gibi isimlendirmek.
- **Statik lint**: hiçbir şey çalıştırılmadan, dışarıdan çağrılabilen fonksiyonlarda mapping olmayan storage'a
  yapılan yazımları işaretlemek.
