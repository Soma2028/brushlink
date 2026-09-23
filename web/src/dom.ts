// DOM まわりの小さな共通処理。

// アップロードされたファイルの中身（セル値・列名）を innerHTML に差し込む
// 箇所があるため、HTML として解釈されないようにエスケープする。
export function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

/**
 * 用語の説明を出す「?」マークの HTML。ホバーまたはキーボードでフォーカス
 * すると吹き出しで説明が出る（style.css の .help）。
 * 母集団・欠測・p 値のような用語を、初心者が画面を離れずに確認できるように
 * するため。データサイエンティストには邪魔にならないよう、小さな記号に留める。
 */
export function helpTip(text: string): string {
  return `<span class="help" tabindex="0" role="note" aria-label="${escapeHtml(text)}" data-tip="${escapeHtml(text)}">?</span>`;
}

let toastTimer: number | undefined;

/** 画面下に数秒だけ出る通知。列の追加など、画面の別の場所が変わる操作の結果を伝える。 */
export function toast(message: string) {
  let el = document.querySelector<HTMLDivElement>('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), 3500);
}

/**
 * 「?」マーク（helpTip）の吹き出しを出す仕組みを、ページ全体に1回だけ仕込む。
 * CSS の ::after で吹き出しを出すと、横スクロールする表の中では
 * 吹き出しが枠で切れてしまうため、body 直下の要素を1つ使い回して
 * 画面座標（position: fixed）で置く。
 */
export function installHelpTooltips() {
  const bubble = document.createElement('div');
  bubble.className = 'tooltip';
  bubble.setAttribute('role', 'tooltip');
  bubble.hidden = true;
  document.body.appendChild(bubble);

  const show = (target: HTMLElement) => {
    bubble.textContent = target.dataset.tip ?? '';
    bubble.hidden = false;
    const r = target.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left + r.width / 2 - b.width / 2), window.innerWidth - b.width - 8);
    // 上に余白がなければ下に出す
    const top = r.top - b.height - 8 >= 8 ? r.top - b.height - 8 : r.bottom + 8;
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
  };
  const hide = () => (bubble.hidden = true);
  const tipTarget = (e: Event) => (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-tip]') ?? null;

  document.addEventListener('mouseover', (e) => {
    const t = tipTarget(e);
    if (t) show(t);
  });
  document.addEventListener('mouseout', (e) => {
    if (tipTarget(e)) hide();
  });
  document.addEventListener('focusin', (e) => {
    const t = tipTarget(e);
    if (t) show(t);
  });
  document.addEventListener('focusout', hide);
  window.addEventListener('scroll', hide, true);
}
