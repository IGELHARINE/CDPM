// 탭의 네트워크 기록에서 봇 탐지·세션 녹화·분석(텔레메트리) 신호를 알아본다.
// 이미 들어오는 네트워크 이벤트(요청 주소, 응답 머리글, 보낸 쿠키 이름)만 본다: 페이지에 아무것도 넣지 않고 Chrome에 명령도 더 보내지 않는다.
// 결과는 에이전트가 사용자에게 알리는 데 쓴다 (봇 탐지·차단·세션 녹화는 처음 보일 때 한 번, 나머지는 browser_network telemetry로).

export type SignalKind = 'bot' | 'challenge' | 'replay' | 'analytics' | 'other';

export interface Vendor {
  name: string;
  kind: SignalKind;
  /** 이 도메인(과 그 하위 도메인)으로 가는 요청 */
  hosts?: string[];
  /** 경로 조건 (hosts가 있으면 둘 다 맞아야 한다) */
  path?: RegExp;
  /** 보낸 쿠키 이름 */
  cookie?: RegExp;
  /** 막을 때 쓸 Fetch 패턴. 없으면 hosts로 만든다 (path가 있는데 block이 없으면 주소로는 못 막는다) */
  block?: string[];
}

const h = (...d: string[]) => d;

// 알려진 업체. 공개된 업체 문서·차단 목록(EasyPrivacy·Disconnect 등)에 널리 알려진 수집 도메인만 넣는다.
export const VENDORS: Vendor[] = [
  // ── 봇 탐지·기기 지문·부정 거래 탐지 ──
  { name: 'Akamai Bot Manager', kind: 'bot', path: /^\/akam\/\d+\//, cookie: /^(_abck|bm_sz|bm_sv|ak_bmsc|bm_mi|bm_so|bm_lso)$/, block: ['*/akam/*'] },
  { name: 'Cloudflare Bot Management', kind: 'bot', path: /^\/cdn-cgi\/challenge-platform\//, cookie: /^(__cf_bm|cf_clearance|__cflb|_cfuvid)$/, block: ['*/cdn-cgi/challenge-platform/*'] },
  { name: 'Cloudflare Turnstile', kind: 'bot', hosts: h('challenges.cloudflare.com') },
  { name: 'PerimeterX / HUMAN', kind: 'bot', hosts: h('px-cdn.net', 'px-cloud.net', 'perimeterx.net', 'pxchk.net', 'px-client.net', 'humansecurity.com'), cookie: /^(_px\d?|_pxvid|_pxhd|pxcts|_pxff_.*|_pxde)$/ },
  { name: 'DataDome', kind: 'bot', hosts: h('datadome.co', 'captcha-delivery.com'), cookie: /^datadome$/ },
  { name: 'Imperva / Incapsula', kind: 'bot', path: /^\/_Incapsula_Resource/i, cookie: /^(incap_ses_.*|visid_incap_.*|nlbi_.*|reese84|___utmvc)$/, block: ['*/_Incapsula_Resource*'] },
  { name: 'Kasada', kind: 'bot', path: /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(ips\.js|tl|fp)\b/, cookie: /^KP_UIDz/, block: ['*/????????-????-????-????-????????????/????????-????-????-????-????????????/*'] },
  { name: 'F5 Shape / Distributed Cloud', kind: 'bot', cookie: /^(TS01[0-9a-f]{6}|TS[0-9a-f]{8})$/ },
  { name: 'Radware Bot Manager (ShieldSquare)', kind: 'bot', hosts: h('perfdrive.com', 'shieldsquare.com', 'shieldsquare.net'), cookie: /^__uz(ma|mb|mc|md|me|mf)$/ },
  { name: 'AWS WAF bot control', kind: 'bot', hosts: h('awswaf.com'), cookie: /^aws-waf-token$/ },
  { name: 'Akamai Account Protector', kind: 'bot', cookie: /^(ak_bmsc_ap|_aap)$/ },
  { name: 'CHEQ', kind: 'bot', hosts: h('cheqzone.com', 'cheq.ai') },
  { name: 'FingerprintJS', kind: 'bot', hosts: h('fpjs.io', 'fpcdn.io', 'fpnpmcdn.net', 'fptls.com', 'fpjs.pro') },
  { name: 'ThreatMetrix (LexisNexis)', kind: 'bot', hosts: h('online-metrix.net', 'thmxyz.com') },
  { name: 'iovation (TransUnion)', kind: 'bot', hosts: h('iesnare.com', 'iovation.com') },
  { name: 'NuData (Mastercard)', kind: 'bot', hosts: h('nudatasecurity.com', 'nd.nudatasecurity.com') },
  { name: 'BioCatch', kind: 'bot', hosts: h('biocatch.com', 'bc2-wup.biocatch.com') },
  { name: 'Kount', kind: 'bot', hosts: h('kaxsdc.com', 'kount.net') },
  { name: 'Sift', kind: 'bot', hosts: h('sift.com', 'siftscience.com', 'hexagon-analytics.com') },
  { name: 'Forter', kind: 'bot', hosts: h('forter.com') },
  { name: 'Riskified', kind: 'bot', hosts: h('riskified.com') },
  { name: 'Signifyd', kind: 'bot', hosts: h('signifyd.com') },
  { name: 'SEON', kind: 'bot', hosts: h('seon.io', 'seondnsresolve.com') },
  { name: 'Castle', kind: 'bot', hosts: h('castle.io') },
  { name: 'Stripe fraud signals', kind: 'bot', hosts: h('m.stripe.network', 'm.stripe.com') },
  { name: 'Google reCAPTCHA', kind: 'bot', hosts: h('google.com', 'gstatic.com', 'recaptcha.net'), path: /^\/recaptcha\//, block: ['*://www.google.com/recaptcha/*', '*://www.gstatic.com/recaptcha/*', '*://*.recaptcha.net/*'] },
  { name: 'hCaptcha', kind: 'bot', hosts: h('hcaptcha.com') },
  { name: 'Arkose Labs (FunCaptcha)', kind: 'bot', hosts: h('arkoselabs.com', 'funcaptcha.com') },
  { name: 'GeeTest', kind: 'bot', hosts: h('geetest.com', 'geevisit.com', 'gsensebot.com') },
  { name: 'Friendly Captcha', kind: 'bot', hosts: h('friendlycaptcha.com', 'frcapi.com') },
  { name: 'MTCaptcha', kind: 'bot', hosts: h('mtcaptcha.com') },
  { name: 'Yandex SmartCaptcha', kind: 'bot', hosts: h('smartcaptcha.yandexcloud.net') },
  { name: 'Tencent Captcha', kind: 'bot', hosts: h('captcha.qq.com', 'turing.captcha.qcloud.com', 'turing.captcha.gtimg.com') },
  { name: 'Alibaba Cloud captcha (AWSC)', kind: 'bot', hosts: h('alicdn.com', 'aliyuncs.com'), path: /^\/(AWSC|captcha)\//i, block: ['*://g.alicdn.com/AWSC/*'] },
  // ── 세션 녹화 (마우스 움직임·클릭·입력·화면 변화를 기록해 보낸다) ──
  { name: 'Hotjar', kind: 'replay', hosts: h('hotjar.com', 'hotjar.io') },
  { name: 'Microsoft Clarity', kind: 'replay', hosts: h('clarity.ms') },
  { name: 'FullStory', kind: 'replay', hosts: h('fullstory.com') },
  { name: 'LogRocket', kind: 'replay', hosts: h('logrocket.io', 'logrocket.com', 'lr-ingest.io', 'lr-ingest.com', 'lr-in.com', 'lr-in-prod.com', 'lrkt-in.com') },
  { name: 'Mouseflow', kind: 'replay', hosts: h('mouseflow.com') },
  { name: 'Smartlook', kind: 'replay', hosts: h('smartlook.com', 'smartlook.cloud') },
  { name: 'Contentsquare', kind: 'replay', hosts: h('contentsquare.net', 'contentsquare.com') },
  { name: 'Quantum Metric', kind: 'replay', hosts: h('quantummetric.com') },
  { name: 'Glassbox', kind: 'replay', hosts: h('glassboxdigital.io', 'glassboxcdn.com') },
  { name: 'Inspectlet', kind: 'replay', hosts: h('inspectlet.com') },
  { name: 'Lucky Orange', kind: 'replay', hosts: h('luckyorange.com', 'luckyorange.net') },
  { name: 'Crazy Egg', kind: 'replay', hosts: h('crazyegg.com') },
  { name: 'SessionCam', kind: 'replay', hosts: h('sessioncam.com') },
  { name: 'Medallia DXA (Decibel)', kind: 'replay', hosts: h('decibelinsight.net') },
  { name: 'Heap', kind: 'replay', hosts: h('heap.io', 'heapanalytics.com', 'heap-api.com') },
  { name: 'OpenReplay', kind: 'replay', hosts: h('openreplay.com') },
  { name: 'Highlight', kind: 'replay', hosts: h('highlight.io', 'highlight.run') },
  { name: 'Zipy', kind: 'replay', hosts: h('zipy.ai') },
  { name: 'Yandex Metrica (Webvisor)', kind: 'replay', hosts: h('mc.yandex.ru', 'mc.yandex.com', 'mc.webvisor.org', 'mc.webvisor.com') },
  { name: 'Beusable', kind: 'replay', hosts: h('beusable.net') },
  { name: 'Datadog RUM', kind: 'replay', hosts: h('browser-intake-datadoghq.com', 'browser-intake-datadoghq.eu', 'browser-intake-us3-datadoghq.com', 'browser-intake-us5-datadoghq.com', 'browser-intake-ap1-datadoghq.com', 'browser-intake-ddog-gov.com', 'datadoghq-browser-agent.com') },
  { name: 'Dynatrace RUM', kind: 'replay', hosts: h('js-cdn.dynatrace.com') },
  { name: 'Dynatrace RUM', kind: 'replay', path: /^\/rb_[a-z0-9]+/i, block: ['*/rb_*'] },
  // ── 분석·광고·성능·오류 수집 ──
  { name: 'Google Analytics / Tag Manager', kind: 'analytics', hosts: h('google-analytics.com', 'googletagmanager.com', 'analytics.google.com', 'stats.g.doubleclick.net') },
  { name: 'Google Ads / DoubleClick', kind: 'analytics', hosts: h('doubleclick.net', 'googleadservices.com', 'googlesyndication.com', 'adservice.google.com') },
  { name: 'Google Ads / DoubleClick', kind: 'analytics', hosts: h('google.com'), path: /^\/(rmkt\/collect|pagead\/|ads\/ga-audiences)/, block: ['*://www.google.com/rmkt/collect*', '*://www.google.com/pagead/*', '*://www.google.com/ads/ga-audiences*'] },
  { name: 'Google internal logging', kind: 'analytics', hosts: h('play.google.com', 'www.google.com', 'firebaselogging-pa.googleapis.com'), path: /^\/(log|gen_204|ccm\/collect)\b/, block: ['*://play.google.com/log*', '*://www.google.com/gen_204*', '*://firebaselogging-pa.googleapis.com/*'] },
  { name: 'Firebase Analytics', kind: 'analytics', hosts: h('app-measurement.com', 'firebaseinstallations.googleapis.com') },
  { name: 'Meta Pixel', kind: 'analytics', hosts: h('connect.facebook.net') },
  { name: 'Meta Pixel', kind: 'analytics', hosts: h('facebook.com'), path: /^\/tr\/?$/, block: ['*://www.facebook.com/tr*', '*://www.facebook.com/tr/*'] },
  { name: 'Microsoft Bing UET', kind: 'analytics', hosts: h('bat.bing.com', 'bat.bing.net') },
  { name: 'Microsoft telemetry (1DS / App Insights)', kind: 'analytics', hosts: h('events.data.microsoft.com', 'js.monitor.azure.com', 'dc.services.visualstudio.com', 'applicationinsights.azure.com') },
  { name: 'LinkedIn Insight', kind: 'analytics', hosts: h('px.ads.linkedin.com', 'snap.licdn.com') },
  { name: 'X (Twitter) Pixel', kind: 'analytics', hosts: h('static.ads-twitter.com', 'analytics.twitter.com', 'ads-api.twitter.com') },
  { name: 'Pinterest Tag', kind: 'analytics', hosts: h('ct.pinterest.com') },
  { name: 'Snap Pixel', kind: 'analytics', hosts: h('tr.snapchat.com', 'sc-static.net') },
  { name: 'Reddit Pixel', kind: 'analytics', hosts: h('alb.reddit.com', 'pixel-config.reddit.com') },
  { name: 'TikTok Pixel', kind: 'analytics', hosts: h('analytics.tiktok.com', 'analytics-ipv6.tiktokw.us') },
  { name: 'Naver Analytics', kind: 'analytics', hosts: h('wcs.naver.net', 'wcs.naver.com') },
  { name: 'Naver logging', kind: 'analytics', hosts: h('nlog.naver.com', 'tivan.naver.com', 'lcs.naver.com', 'cologger.shopping.naver.com', 'nelo2-col.navercorp.com') },
  { name: 'Kakao Pixel', kind: 'analytics', hosts: h('pixel.kakao.com', 'bc.ad.daum.net') },
  { name: 'Daum / Kakao logging', kind: 'analytics', hosts: h('stat.tiara.daum.net', 'stat.tiara.kakao.com', 'tiara.daum.net', 'tiara.kakao.com') },
  { name: 'AceCounter', kind: 'analytics', hosts: h('acecounter.com') },
  { name: 'BizSpring Logger', kind: 'analytics', hosts: h('logger.co.kr') },
  { name: 'Dable', kind: 'analytics', hosts: h('dable.io') },
  { name: 'Mobon', kind: 'analytics', hosts: h('mobon.net') },
  { name: 'Hackle', kind: 'analytics', hosts: h('hackle.io') },
  { name: 'Airbridge', kind: 'analytics', hosts: h('airbridge.io') },
  { name: 'Baidu Tongji', kind: 'analytics', hosts: h('hm.baidu.com') },
  { name: 'Amplitude', kind: 'analytics', hosts: h('api.amplitude.com', 'api2.amplitude.com', 'api.eu.amplitude.com', 'cdn.amplitude.com', 'sr-client-cfg.amplitude.com') },
  { name: 'Mixpanel', kind: 'analytics', hosts: h('api.mixpanel.com', 'api-js.mixpanel.com', 'api-eu.mixpanel.com', 'cdn.mxpnl.com') },
  { name: 'Segment', kind: 'analytics', hosts: h('api.segment.io', 'cdn.segment.io', 'cdn.segment.com') },
  { name: 'RudderStack', kind: 'analytics', hosts: h('rudderstack.com', 'rudderlabs.com') },
  { name: 'PostHog', kind: 'analytics', hosts: h('i.posthog.com', 'app.posthog.com') },
  { name: 'Pendo', kind: 'analytics', hosts: h('cdn.pendo.io', 'app.pendo.io', 'data.pendo.io') },
  { name: 'Adobe Analytics', kind: 'analytics', hosts: h('omtrdc.net', 'demdex.net', '2o7.net', 'adobedc.net') },
  { name: 'Optimizely', kind: 'analytics', hosts: h('logx.optimizely.com', 'cdn.optimizely.com') },
  { name: 'HubSpot', kind: 'analytics', hosts: h('hs-analytics.net', 'hs-scripts.com', 'hs-banner.com', 'track.hubspot.com') },
  { name: 'Marketo', kind: 'analytics', hosts: h('mktoresp.com', 'munchkin.marketo.net') },
  { name: 'Clearbit', kind: 'analytics', hosts: h('clearbitjs.com', 'clearbitscripts.com') },
  { name: 'StackAdapt', kind: 'analytics', hosts: h('srv.stackadapt.com') },
  { name: 'Braze', kind: 'analytics', hosts: h('braze.com', 'braze.eu', 'appboycdn.com') },
  { name: 'AppsFlyer', kind: 'analytics', hosts: h('appsflyer.com', 'onelink.me') },
  { name: 'Adjust', kind: 'analytics', hosts: h('adjust.com') },
  { name: 'Branch', kind: 'analytics', hosts: h('branch.io') },
  { name: 'Matomo / Piwik', kind: 'analytics', path: /\/(matomo|piwik)\.(php|js)$/, block: ['*/matomo.php*', '*/piwik.php*', '*/matomo.js*', '*/piwik.js*'] },
  { name: 'Plausible', kind: 'analytics', hosts: h('plausible.io') },
  { name: 'Fathom', kind: 'analytics', hosts: h('usefathom.com') },
  { name: 'Cloudflare Web Analytics', kind: 'analytics', hosts: h('cloudflareinsights.com') },
  { name: 'Vercel Analytics', kind: 'analytics', hosts: h('vercel-insights.com') },
  { name: 'Vercel Analytics', kind: 'analytics', path: /^\/_vercel\/(insights|speed-insights)\//, block: ['*/_vercel/insights/*', '*/_vercel/speed-insights/*'] },
  { name: 'Comscore', kind: 'analytics', hosts: h('scorecardresearch.com') },
  { name: 'Quantcast', kind: 'analytics', hosts: h('quantserve.com', 'quantcount.com') },
  { name: 'Chartbeat', kind: 'analytics', hosts: h('chartbeat.com', 'chartbeat.net') },
  { name: 'Criteo', kind: 'analytics', hosts: h('criteo.com', 'criteo.net') },
  { name: 'Taboola', kind: 'analytics', hosts: h('taboola.com') },
  { name: 'Outbrain', kind: 'analytics', hosts: h('outbrain.com') },
  { name: 'Amazon Ads', kind: 'analytics', hosts: h('amazon-adsystem.com') },
  { name: 'The Trade Desk', kind: 'analytics', hosts: h('adsrvr.org') },
  { name: 'Sentry', kind: 'analytics', hosts: h('ingest.sentry.io', 'ingest.us.sentry.io', 'ingest.de.sentry.io', 'sentry-cdn.com') },
  { name: 'Bugsnag', kind: 'analytics', hosts: h('bugsnag.com') },
  { name: 'Rollbar', kind: 'analytics', hosts: h('rollbar.com') },
  { name: 'TrackJS', kind: 'analytics', hosts: h('trackjs.com') },
  { name: 'New Relic', kind: 'analytics', hosts: h('nr-data.net', 'js-agent.newrelic.com') },
  { name: 'AppDynamics', kind: 'analytics', hosts: h('eum-appdynamics.com') },
  { name: 'Akamai mPulse', kind: 'analytics', hosts: h('go-mpulse.net', 'akstat.io') },
  { name: 'Elastic APM', kind: 'analytics', path: /^\/intake\/v2\/rum\/events/, block: ['*/intake/v2/rum/events*'] },
];

// 이름 없는 수집 주소 (사이트 자체 로그 등): sendBeacon 이거나 경로가 수집처럼 생긴 POST
const GENERIC = /\/(collect|beacon|telemetry|log|logs|logging|metrics|track|tracking|events?|rum|analytics|stats|pixel)(\/|\?|$|\.)/i;

export interface Signal {
  vendor: string;
  kind: SignalKind;
  requests: number;
  posts: number;
  /** 보낸 데이터 크기 합 (알 수 있는 것만) */
  sentBytes: number;
  hosts: Set<string>;
  /** 무엇으로 알아봤는지 (쿠키 이름, 응답 코드 등) — 몇 개만 */
  evidence: Set<string>;
  firstAt: number;
  lastAt: number;
  /** 이름 없는 수집 주소(other)를 막을 때 쓸 패턴 */
  pattern?: string;
}

const MAX_SIGNALS = 120;
const MAX_EVIDENCE = 4;

function hostPath(url: string): { host: string; hp: string } | undefined {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return undefined;
    return { host: u.hostname, hp: u.hostname + u.pathname };
  } catch {
    return undefined;
  }
}

function hostIs(host: string, d: string): boolean {
  return host === d || host.endsWith('.' + d);
}

/** 요청 주소로 업체를 찾는다 (없으면 undefined). */
export function vendorOfUrl(url: string): Vendor | undefined {
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  if (!/^(https?|wss?):$/.test(u.protocol)) return undefined;
  const host = u.hostname.toLowerCase();
  return VENDORS.find((v) => (v.hosts || v.path) && (!v.hosts || v.hosts.some((d) => hostIs(host, d))) && (!v.path || v.path.test(u.pathname)));
}

/** 업체를 막을 Fetch 패턴 (주소로 막을 수 없는 업체는 빈 목록). */
export function blockPatterns(v: Vendor): string[] {
  if (v.block) return v.block;
  if (v.path || !v.hosts) return [];
  return v.hosts.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);
}

/** 이름·종류로 업체를 고른다: "replay"·"session recording", "analytics", "bot", 또는 업체 이름 일부("hotjar"). */
export function vendorsFor(query: string): Vendor[] {
  const q = query.trim().toLowerCase();
  const kind: Record<string, SignalKind> = { replay: 'replay', 'session recording': 'replay', recording: 'replay', analytics: 'analytics', ads: 'analytics', bot: 'bot', 'bot detection': 'bot', fingerprinting: 'bot', captcha: 'bot' };
  if (kind[q]) return VENDORS.filter((v) => v.kind === kind[q] && (q !== 'captcha' || /captcha|turnstile/i.test(v.name)));
  return VENDORS.filter((v) => v.name.toLowerCase().includes(q));
}

const cookieCache = new Map<string, Vendor | null>();
/** 쿠키 이름으로 업체를 찾는다. (요청마다 같은 쿠키가 실리므로 이름별로 기억해 둔다) */
export function vendorOfCookie(name: string): Vendor | undefined {
  let v = cookieCache.get(name);
  if (v === undefined) {
    if (cookieCache.size > 1000) cookieCache.clear();
    v = VENDORS.find((x) => x.cookie?.test(name)) ?? null;
    cookieCache.set(name, v);
  }
  return v ?? undefined;
}

/** 페이지 문서 응답이 차단·확인 화면인지 (응답 코드와 머리글로). */
export function challengeOf(status: number, headers: Record<string, string> | undefined): string | undefined {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) h[k.toLowerCase()] = String(v);
  if (h['cf-mitigated']) return `Cloudflare (${status}, cf-mitigated: ${h['cf-mitigated']})`;
  if (![403, 405, 429, 503].includes(status)) return undefined;
  if (h['x-datadome'] || h['x-dd-b']) return `DataDome (${status})`;
  if (/cloudflare/i.test(h.server ?? '')) return `Cloudflare (${status})`;
  if (/akamai/i.test(h.server ?? '') || h['akamai-grn']) return `Akamai (${status})`;
  if (h['x-iinfo'] || h['x-cdn'] === 'Imperva') return `Imperva (${status})`;
  if (Object.keys(h).some((k) => k.startsWith('x-px'))) return `PerimeterX (${status})`;
  if (h['x-amzn-waf-action']) return `AWS WAF (${status}, ${h['x-amzn-waf-action']})`;
  if (status === 429) return 'rate limit (429)';
  return undefined;
}

/** 탭 하나의 신호 모음. NetworkRecorder가 이벤트를 넘겨 준다. */
export class TelemetryLog {
  private signals = new Map<string, Signal>();
  /** 사이트|업체 → 이미 알렸음 */
  private told = new Set<string>();
  /** 아직 알리지 않은 차단·확인 화면 */
  private pendingChallenges: string[] = [];

  private hit(vendor: string, kind: SignalKind, at: number, host?: string, evidence?: string): Signal {
    let s = this.signals.get(vendor);
    if (!s) {
      if (this.signals.size >= MAX_SIGNALS) {
        // 가장 오래 안 보인 것을 버린다
        const oldest = [...this.signals.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
        this.signals.delete(oldest[0]);
      }
      s = { vendor, kind, requests: 0, posts: 0, sentBytes: 0, hosts: new Set(), evidence: new Set(), firstAt: at, lastAt: at };
      this.signals.set(vendor, s);
    }
    s.lastAt = at;
    if (host && s.hosts.size < MAX_EVIDENCE) s.hosts.add(host);
    if (evidence && s.evidence.size < MAX_EVIDENCE) s.evidence.add(evidence);
    return s;
  }

  onRequest(p: { url: string; method: string; type?: string; postLen?: number; at: number }) {
    const v = vendorOfUrl(p.url);
    const x = hostPath(p.url);
    let s: Signal | undefined;
    if (v) s = this.hit(v.name, v.kind, p.at, x?.host);
    else if (x && (p.type === 'Ping' || (p.method === 'POST' && GENERIC.test(new URL(p.url).pathname)))) {
      // 숫자·긴 해시가 든 경로 조각부터는 잘라 하나로 묶는다 (/rmkt/collect/8755…/ 여러 개 → /rmkt/collect/…)
      const segs = new URL(p.url).pathname.split('/');
      const cut = segs.findIndex((x, i) => i > 0 && /\d{4,}|[0-9a-f]{16,}/i.test(x));
      const pathKey = (cut > 0 ? `${segs.slice(0, cut).join('/')}/…` : segs.join('/')).slice(0, 60);
      s = this.hit(`${x.host}${pathKey}`, 'other', p.at, x.host);
      s.pattern ??= `*://${x.host}${pathKey.replace(/…$/, '')}*`;
    }
    if (!s) return;
    s.requests++;
    if (p.method === 'POST' || p.type === 'Ping') s.posts++;
    if (p.postLen) s.sentBytes += p.postLen;
  }

  onCookies(names: string[], at: number) {
    for (const n of names) {
      const v = vendorOfCookie(n);
      if (v) this.hit(v.name, v.kind, at, undefined, `cookie ${n.length > 20 ? n.slice(0, 20) + '…' : n}`);
    }
  }

  onDocumentResponse(url: string, status: number, headers: Record<string, string> | undefined, at: number) {
    const c = challengeOf(status, headers);
    if (!c) return;
    const x = hostPath(url);
    this.hit(`Block/challenge: ${c.split(' (')[0]}`, 'challenge', at, x?.host, `${status} on ${x?.hp.slice(0, 60) ?? url}`);
    if (this.pendingChallenges.length < 5) this.pendingChallenges.push(`${c} on ${x?.hp.slice(0, 80) ?? url}`);
  }

  list(): Signal[] {
    const order: Record<SignalKind, number> = { challenge: 0, bot: 1, replay: 2, analytics: 3, other: 4 };
    return [...this.signals.values()].sort((a, b) => order[a.kind] - order[b.kind] || b.requests - a.requests);
  }

  /** 이 사이트에서 아직 알리지 않은 봇 탐지·차단·세션 녹화 신호를 한 줄로 (없으면 undefined). 알린 것은 다시 안 알린다. */
  takeNotice(site: string): string | undefined {
    const parts: string[] = [];
    const challenges = this.pendingChallenges.splice(0);
    for (const s of this.list()) {
      if (s.kind !== 'bot' && s.kind !== 'replay') continue;
      const k = `${site}|${s.vendor}`;
      if (this.told.has(k)) continue;
      if (this.told.size > 2000) this.told.clear();
      this.told.add(k);
      parts.push(`${s.vendor} (${s.kind === 'bot' ? 'bot detection' : 'session recording'}${describe(s)})`);
    }
    if (!parts.length && !challenges.length) return undefined;
    const lines: string[] = [];
    if (challenges.length) lines.push(`[signal] The site blocked or challenged a page load: ${challenges.join('; ')}.`);
    if (parts.length) lines.push(`[signal] Detection/telemetry seen on ${site}: ${parts.join(', ')}.`);
    lines.push('Tell the user in one short line (what it is; CDPM only observed it). Don\'t block anything unless the user asks. Details: browser_network telemetry: true.');
    return lines.join('\n');
  }
}

function describe(s: Signal): string {
  const bits: string[] = [];
  if (s.evidence.size) bits.push([...s.evidence].join(', '));
  if (s.posts) bits.push(`${s.posts} data send${s.posts > 1 ? 's' : ''}`);
  return bits.length ? `; ${bits.join(', ')}` : '';
}

const KIND_LABEL: Record<SignalKind, string> = {
  challenge: 'Blocks / challenges',
  bot: 'Bot detection / fingerprinting',
  replay: 'Session recording',
  analytics: 'Analytics / ads / error reporting',
  other: 'Other data-collection endpoints (guessed from the path)',
};

const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`);

/** browser_network telemetry: true 의 결과. */
export function telemetryReport(log: TelemetryLog, since: string): string {
  const all = log.list();
  if (!all.length) return `No known detection or telemetry traffic recorded on this tab since ${since}.`;
  const out = [`Telemetry analysis of this tab's traffic since ${since} (passive: CDPM only observed it).`];
  for (const kind of ['challenge', 'bot', 'replay', 'analytics', 'other'] as SignalKind[]) {
    const group = all.filter((s) => s.kind === kind);
    if (!group.length) continue;
    out.push(`\n${KIND_LABEL[kind]}:`);
    for (const s of group.slice(0, 15)) {
      const bits = s.kind === 'challenge' ? [] : s.requests ? [`${s.requests} request${s.requests === 1 ? '' : 's'}`] : [];
      if (s.posts) bits.push(`${s.posts} sent${s.sentBytes ? ` (${kb(s.sentBytes)})` : ''}`);
      if (s.hosts.size) bits.push([...s.hosts].join(', '));
      if (s.evidence.size) bits.push([...s.evidence].join(', '));
      out.push(`  - ${s.vendor}: ${bits.join(' · ')}`);
    }
    if (group.length > 15) out.push(`  … ${group.length - 15} more`);
  }
  out.push('\nBot detection scores the browser and behavior; a block/challenge means the site already doubted this session. Blocking these scripts with browser_block usually makes the site refuse you, so do it only if the user asks.');
  return out.join('\n');
}
