# hotslot

[English](README.md) · **Türkçe**

Monad bir bloktaki işlemleri paralel çalıştırır, ama sadece aynı state'e dokunmayanları. hotslot, işlemlerin
birbirini beklemesine sebep olan storage slot'larını ve MON bakiyelerini bulur. Her birinin neden sıcak olduğunu
ve nasıl düzeltileceğini söyler. Kendi kontratını da deploy etmeden önce test edebilirsin.

```sh
npx hotslot scan                      # Monad mainnet'i şu an ne sıralı hale getiriyor
npx hotslot init MyContract           # Foundry projende: ABI'den test senaryosu yaz
npx hotslot simulate hotslot/mycontract.json --min-parallelism 8
```

## Problem

Monad bir bloktaki bütün işlemleri aynı anda çalıştırır. Her biri bloğun başındaki state üzerinde çalışır ve
sonuçlar sırayla kaydedilir. 7. işlem, 3. işlemin yazdığı bir slot'u okuduysa eski bir değer görmüştür. Sonucu
atılır ve 3. işlemden sonra tekrar çalışır. Pratikte 7. işlem, 3. işlem bitmeden bitemez.

Bu beklemeleri blok boyunca takip edince bir zincir çıkar. Her çağrıda `totalCount += 1` yapan bir kontrat,
kendisine gelen çağrılardan oluşan bir bloğu tek bir zincire çevirir. 16 çekirdekli makinede çağrılar birer
birer çalışır.

Bunu sana hiçbir şey söylemez. Ethereum için yazılan kontratlar global bir sayaç için hiç bedel ödemedi, çünkü
Ethereum zaten sıralı çalışıyor. Monad tam EVM uyumlu. Solana'daki gibi erişim listesi beyan etmezsin. Hata
yok, ekstra gas yok, uyarı yok. Kontrat çalışır, sadece sıralı çalışır.

## Bugün mainnet'te durum

Art arda 499 Monad mainnet bloğu (122.988.945–122.989.444, 17 Kasım 2026), 15.410 işlem:

| | |
|---|---|
| aynı bloktaki önceki bir işlemi beklemek zorunda kalan işlemler | **%70** |
| blokların sahip olabileceği paralellik (blok başına işlem) | 30,9× |
| gerçekte sahip oldukları paralellik (işlem ÷ en uzun zincir) | **2,13×** |
| aynısı, gas ağırlıklı | 11,1× mümkünken 1,61× |

Mümkün olan paralelliğin %93'ü kayboluyor. En büyük tek sebep bir akış.

**Tip yolu.** Aralıktaki bütün işlemlerin %41'i (15.410'un 6.257'si) aynı türden ve hepsi beklemiş. Bir trading bot işlemi `0xd32e…ff58` üzerinden geçiyor: bir orderbook'ta işlem
yapıyor, staking precompile'dan bloğun validator'ünü okuyor ve **ShMonad** (`0x1b68…e19c`,
`sendValidatorRewards`) üzerinden o validator'e 0,07 MON bahşiş ödüyor. Bu işlemlerin her biri:

- ShMonad'daki aynı ortak sayaçlara yazıyor (o validator'e borçlu olunan ödül ve global toplamlar);
- ShMonad'ın bakiyesine MON gönderiyor. Bu bakiyeyi bloktaki diğer bütün bahşişler de değiştiriyor.

Bunlardan biri tek başına bile bloktaki bütün bahşişleri tek zincire dizmeye yetiyor. hotslot'un ShMonad için
gösterdiği:

```
$ npx hotslot scan --blocks 500 --contract 0x1b68626dca36c7fe922fd2d55e4f631d962de19c

  ShMonad (0x1b68626dca36c7fe922fd2d55e4f631d962de19c)
    txs that used it      6043, of which 100% waited on an earlier tx
    if it were fixed      network 2.13x → 2.13x
    fixed together with 0xd32e…ff58: network 2.13x → 4.81x  the same txs wait on both
```

ShMonad'ı tek başına düzeltmek hiçbir şey kazandırmıyor, çünkü aynı işlemler `0xd32e`'yi de bekliyor. İkisi
birlikte düzeltilirse **bütün ağın paralelliği iki katından fazla artıyor: 2,13× → 4,81×** (gas ağırlıklı
1,61× → 3,98×). Bir geliştiricinin değiştirebileceği en kötü 6 kontrat sırayla düzeltilirse:

| düzeltilen | ağ paralelliği |
|---|---|
| bugün | 2,13× |
| + `0x34b6…2a6f` (büyük ihtimalle bir perp DEX'in emir yürütmesi) | 2,23× |
| + `0xd32e…ff58` (tip yolu) | 2,27× |
| + ShMonad | **5,86×** |
| + 3 orderbook marketi | 6,47× |

Buradaki "düzeltilmiş", kontratın slot'larının ve MON bakiyesinin artık çakışmaması demek. Geri kalan her şey,
yani diğer kontratlar ve her göndericinin kendi işlem sırası, yerinde kalıyor.

**Çözüm sıradan bir tasarım değişikliği.** Searcher'lar bir kere bakiye yatırır, her bahşişte o bakiyeden düşülür.
Validator'e olan borç bidder başına (ya da blok başına) tutulur ve toplu ödenir.
[`TipVault`](contracts/src/TipVault.sol) bu desenin küçük bir modeli. Aynı blokta 64 kullanıcıyla hotslot onu
**1,00×** ölçüyor. Aynı bahşişler, önceden yatırılan bakiyeden düşen
[`TipVaultEscrow`](contracts/src/TipVaultEscrow.sol) ile **64,00×** çalışıyor.

## Kontratını deploy etmeden önce test et

Node 20+ ve [Foundry](https://getfoundry.sh) gerekiyor. Foundry projenin içinde:

```sh
npx hotslot init TipVault
```

Bu komut, state değiştiren her fonksiyon için bir satır içeren `hotslot/tipvault.json` dosyasını yazar.
Kullanıcılarının hangi çağrıları ne sıklıkla yaptığını (`weight`) seç, argümanları doldur (`"$user"` çağıranın
adresi) ve approve ya da deposit gibi hazırlık adımlarını ekle:

```json
{
  "contract": "TipVault",
  "users": 64,
  "deployValue": "100",
  "actions": [
    { "signature": "bid(uint64)", "args": ["7"], "value": "0.07", "weight": 3 },
    { "signature": "deposit()", "value": "1", "weight": 1 }
  ]
}
```

```sh
npx hotslot simulate hotslot/tipvault.json
```

hotslot kontratı yerel bir anvil zincirine deploy eder ve 64 farklı kullanıcının çağrılarını aynı bloğa koyar.
Sonra hangi state'in onları beklettiğini senin değişken isimlerinle raporlar:

```
TipVault: 64 users in one block
  txs that waited       98% had to wait on an earlier tx in the same block
  parallelism           1.00x of 64.00x possible  (98% lost)

  hottest state and why it is hot
      63 waits  TipVault   MON balance          Shared MON balance · fixable by design
      47 waits  TipVault   totalTips            Shared counter · avoidable
      47 waits  TipVault   bidCount             Shared counter · avoidable
      47 waits  TipVault   lastBidder           Last-writer slot · avoidable
      47 waits  TipVault   rewardsPayable[7]    Shared counter · avoidable
      15 waits  TipVault   totalShares          Data dependency · inherent

  how to fix
    Shared counter: Shard the counter (mapping by msg.sender or by shard id, summed in a view), or drop it
                    and aggregate from events off-chain.
    Last-writer slot: Emit an event instead, or store it per user (mapping keyed by msg.sender).
    Shared MON balance: Have users prefund once (deposit) and debit an internal per-user balance per action ...
```

CI'a `--min-parallelism 8` eklersen, bir değişiklik kontratı sıralı hale getirdiğinde çalıştırma fail eder
(exit code 1). Gas snapshot'larının gas artışlarını yakalaması gibi.

[`contracts/`](contracts/) içindeki demo kontratlar yaygın durumları kapsıyor:

| 64 kullanıcı, tek blok | paralellik | hotslot'un raporu |
|---|---|---|
| `QuestNaive`: global `totalCheckIns`, `lastPlayer` | 1,00× | ortak sayaç ve son-yazan slot'lar, hepsi kaçınılabilir |
| `QuestSharded`: sayaç bir `uint256[64]` üzerine bölünmüş | 21,3× | shard çakışmaları (çakışmalar sayfa bazındaysa 1,00×, aşağıya bak) |
| `QuestShardedMap`: aynı shard'lar bir `mapping` içinde | 21,3× | sadece shard çakışmaları |
| `QuestFixed`: oyuncu başına state, toplamlar event'lerden | 64,0× | hiçbir şey |
| `MiniPool`: sabit çarpımlı AMM | 1,00× | `reserveMon`, `reserveToken`: gerçek bir veri bağımlılığı, kaçınılmaz |
| `TipVault`: bir kontrata giden MON bahşişleri | 1,00× | ortak MON bakiyesi, sayaçlar, son-yazan slot |
| `TipVaultEscrow`: önceden yatırılan bakiyeden düşülen bahşişler | 64,0× | hiçbir şey |

Pool bilerek orada. Naive quest kadar sıralı, ve hotslot hiçbir storage düzeninin bunu düzeltemeyeceğini doğru
şekilde söylüyor. Sadece batching yardımcı olur.

## Mainnet'te

```sh
npx hotslot scan --blocks 300                          # en sıcak kontratlar ve slot'lar
npx hotslot scan --contract 0xKontratın                # kullanıcıların ne kadar bekliyor, düzeltme ne kazandırır
npx hotslot block 122989000                            # tek blok, en uzun zinciri adım adım
```

Varsayılan RPC `https://rpc.monad.xyz`. `debug_traceBlockByNumber` (prestate tracer) ve `debug_traceCall` sunan
her RPC `--rpc` ile çalışır. `scan --min-parallelism` de CI kapısı olarak kullanılabilir.

## Nasıl çalışıyor

1. **Okuma ve yazma kümeleri.** Her blok için prestate tracer'lı `debug_traceBlockByNumber`, her işlemin
   dokunduğu (default mod) ve değiştirdiği (diff mod) her slot'u ve hesabı verir. SSTORE da okuma sayılır,
   çünkü gas'ı mevcut değere bağlıdır.
2. **Bağımlılık grafiği.** Her okuma, bloktaki aynı anahtarı yazan en son önceki işleme bağlanır. Anahtar bir
   storage slot'u, bir hesabın MON bakiyesi ya da bir göndericinin nonce'u olabilir. En uzun yol, kaç çekirdek
   olursa olsun bloğun ihtiyaç duyduğu en az sıralı adım sayısıdır. İşlem sayısının buna bölümü bloğun
   paralelliğidir.
3. **Üç tür bekleme.** Her kenar, neden oluştuğuna göre sınıflanır:
   - *kontrat storage'ı*: ortak bir slot. Kontrat tasarımının elinde.
   - *ortak MON bakiyesi*: farklı göndericilerin aynı hesaba ödeme yapması. Bu da kontrat tasarımının elinde.
   - *aynı gönderici sırası*: bir göndericinin işlemleri nonce sırasıyla çalışır. Kontrat sorunu değil.

   Bir göndericinin kendi bakiyesi sadece nonce üzerinden sayılır. Böylece 20 işlem gönderen bir bot,
   herhangi bir kontratın suçu sayılmaz.
4. **Düzeltilse ne olurdu.** Her kontrat için grafik, onun slot'ları ve bakiyesi çıkarılıp geri kalan her şey
   korunarak yeniden hesaplanır. Kontratlar çoğu zaman *birlikte* sıcaktır (aynı işlemler ikisini de bekler),
   bu yüzden liste açgözlü (greedy) şekilde kurulur. `--contract` ayrıca birlikte düzeltildiğinde en çok
   kazandıran ortağı da arar.
5. **Her slot neden sıcak.** En sıcak slot'lar için birkaç işlem, kendi bloklarında `debug_traceCall` ile
   yeniden oynatılır. O işlemin ve sonrakilerin yazdığı her şey state override'larla geri sarılır. Bir replay,
   ancak işlemin zincirdeki yazmalarını birebir üretirse kullanılır. Sonra sadece sıcak slot'un değeri
   değiştirilir ve etkiler karşılaştırılır:

   | sonuç | anlamı | kaçınılabilir mi |
   |---|---|---|
   | `unused` | değeri değiştirmek hiçbir şeyi değiştirmiyor | evet: okumayı kaldır |
   | `overwrite` | eski değer önemsiz (`lastCaller = msg.sender`) | evet: kullanıcı başına storage ya da event |
   | `accumulator` | işlem sabit bir miktar ekliyor ve başka hiçbir şey ona bağlı değil (`total += x`) | evet: shard'la ya da event'lerden türet |
   | `guard` | değer sadece işlemin revert edip etmeyeceğine karar veriyor (bir limit) | genelde hayır |
   | `dependent` | başka yazmalar ondan hesaplanıyor (rezervlerden fiyat) | hayır: sadece batching yardımcı olur |

6. **İsimler.** Simülasyonlarda slot'lar Solidity storage layout'undan isimlendirilir; bir veya iki seviye
   derinlikteki mapping'ler dahil (`rewardsPayable[7]`, `owed[7][0x…]`). Mainnet'te kontratlar, varsa token
   metadata'sından isimlendirilir.

## Gas ağırlıklı

İşlem saymak, bir transfer ile ağır bir swap'ı aynı adım gibi görür. Bir blok en ağır zinciri bitmeden bitemez,
bu yüzden hotslot her işlemi gas'ıyla da ağırlıklandırır.

Monad gas *limitini* ücretlendirir ve her RPC (receipt'ler, `callTracer`, `debug_traceCall`) `gasUsed` değerini
limite eşit raporlar. Bir işlemin gerçekte harcadığı gas hiçbir yerden alınamıyor. Receipt'lerle ağırlıklandırmak,
göndericinin cüzdanının seçtiği limitle ağırlıklandırmak olurdu. hotslot bunu zaten elindeki trace'lerden, Monad'ın
MIP-8 tarifesiyle tahmin eder ([opcode fiyatları](https://docs.monad.xyz/developer-essentials/opcode-pricing)):

| işlemin dokunduğu | gas |
|---|---|
| intrinsic, calldata, kontrat oluşturma, access list, 7702 yetkilendirmeleri | Ethereum'daki gibi |
| her soğuk hesap (gönderici, alıcı, fee recipient, precompile ya da yeni oluşturulan değil) | 10.100 |
| her 128 slot'luk storage sayfasının ilk slot'u | 8.100 |
| zaten erişilmiş bir sayfadaki diğer her slot | 100 |
| değişen slot'u olan her sayfa | 2.800 |
| her yeni sıfır olmayan slot | 17.000 |
| bir Ethereum precompile çağrısı (en ucuz girdisiyle) | örn. ecRecover 6.000 |

Compute, memory ve log'ları dışarıda bırakır, yani harcanan gas için bir **alt sınırdır**. Harcanan gas da
limiti asla geçemez. Her tarama her işlemde `tahmin ≤ limit` kontrolünü yapar. Yukarıdaki aralıkta sistem dışı
14.911 işlemin hepsinde tutuyor.

| aynı 499 blok | işlem sayarak | gas ağırlıklı |
|---|---|---|
| mümkün olan | 30,9× | 11,1× |
| gerçekleşen | 2,13× | 1,61× |
| sadece kontrat storage'ı olsaydı | 2,14× | 1,61× |
| sadece ortak MON bakiyeleri olsaydı | 2,56× | 1,74× |
| sadece aynı gönderici sırası olsaydı | 7,87× | 6,80× |
| ShMonad ve `0xd32e` düzeltildikten sonra | 4,81× | 3,98× |

## Slot bazında mı sayfa bazında mı (MIP-8)

[MIP-8](https://mips.monad.xyz/MIPs/MIP-8) storage'ı 128 ardışık slot'luk sayfalara ayırır. Sayfa; disk I/O'nun,
state commitment'ın ve SLOAD/SSTORE gas'ının birimidir. MIP-8 çakışmaların slot bazında mı sayfa bazında mı
tespit edildiğini söylemiyor, bu yüzden hotslot ikisini de raporlar.

Çakışmalar sayfa bazındaysa, aynı sayfadaki *farklı* slot'lara yazan iki işlem de birbirini bekler. Buna false
sharing denir; iki CPU çekirdeğinin aynı cache line'daki farklı değişkenlere yazması gibi. Bugünkü mainnet'te
neredeyse fark etmiyor: 21.592 sayfa düzeyindeki beklemenin 182'si (%0,8) false sharing, paralellik iki durumda
da 2,13×. Çünkü sıcak kontratlar zaten aynı slot'larda çakışıyor.

Kontrat tasarımı için ise önemli. `QuestSharded` sayacını bir `uint256[64]` üzerine bölüyor, yani tek sayfada 64
ardışık slot: slot bazında 21×, sayfa bazında 1×. `QuestShardedMap` aynı shard'ları bir mapping'de tutuyor;
mapping girdileri farklı sayfalara hash'lendiği için iki durumda da 21×. **Shard'lamayı array ya da yan yana
değişkenlerle değil, mapping'lerle yap.**

## İddia etmedikleri

- Buradaki paralellik, sınırsız çekirdek varsayımıyla veri bağımlılıklarının koyduğu sınırdır. Monad'ın
  executor'ünün bir ölçümü değildir; gerçek hızlanma çekirdek sayısına, çalıştırma maliyetine ve I/O'ya da
  bağlıdır. Monad'da yeniden çalıştırma ucuzdur çünkü okumalar cache'lenir. Burada sayılan maliyet bekleme
  zinciridir.
- **Ortak MON bakiyeleri.** Monad'ın çalıştırma kodunda bakiyeler için gevşek bir birleştirme var
  (`state3/state.cpp`): bir işlem, bakiyenin tam değeri yerine ihtiyaç duyduğu en düşük bakiyeye göre
  doğrulanabiliyor. Mainnet'in bunu kullanıp kullanmadığını doğrulayamadık. Kullanıyorsa, yoğun bir hesaba
  ödenen MON, hotslot'un saydığından daha az çakışır. Storage çakışmaları bundan etkilenmez. Raporlar bakiye
  beklemelerini ayrı tutar, böylece bir rakamın ne kadarının buna bağlı olduğunu görebilirsin. Bu, Monad
  ekibine açık bir soru.
- Düz bir `BALANCE` okuması tracer'da görünmüyor. Bu yüzden bakiye çakışmaları sadece iki işlem de bakiyeyi
  değiştirdiğinde sayılır.
- Kök neden, slot başına birkaç örnek işlemden (varsayılan 3) belirlenir; en kısıtlayıcı sonuç kazanır. Limitine
  uzak bir guard `unused` gibi görünebilir.
- Sistem işlemleri ve staking precompile, blokta çalıştıkları için grafikte yer alır. Ama yeniden oynatılmazlar
  ve kimse bir precompile'ı "düzeltemez", bu yüzden "düzeltilse ne olurdu" listelerinde yer almazlar.

## Geliştirme

```sh
pnpm install
pnpm hotslot scan --blocks 500 --out data/mainnet.json       # CLI'ı kaynaktan çalıştırır (Node 22.18+)
pnpm hotslot simulate contracts/scenarios/tipvault.json --out data/sim-tipvault.json
pnpm dashboard                                                # data/ üzerinde React dashboard
pnpm test && pnpm typecheck
```

```
packages/core     analiz: tracing, bağımlılık grafiği, atıf, replay probe, gas modeli, etiketler
packages/cli      hotslot komutu (npm'de `hotslot` olarak yayında)
contracts         demo kontratlar (Foundry) ve senaryoları
apps/dashboard    data/ içindeki JSON raporlar üzerinde dashboard (statik, Vercel'e olduğu gibi deploy edilir)
data              bu README'de ve dashboard'da kullanılan raporlar
```

## Sırada ne var

- **Canlı indeks**: sürekli tarayıp kontrat başına geçmiş tutmak; böylece bir protokol hangi sürümün onu sıcak
  noktaya çevirdiğini görür.
- **Mainnet'te slot isimleri**: doğrulanmış kaynaklardan (Sourcify), simülatörün yaptığı gibi.
- **Statik lint**: herhangi bir şey çalışmadan önce, dışarıdan çağrılabilen fonksiyonlarda mapping olmayan
  storage'a yazmaları işaretlemek.

MIT lisansı
