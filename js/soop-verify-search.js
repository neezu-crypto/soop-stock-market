/* 스트리머 인증 신청: SOOP 검색을 기본 방식으로 붙이는 공용 스크립트(2026-11-18).
 * 원본은 StreamBet-Market/js/soop-verify-search.js이고, 각 서비스 저장소에 같은 내용으로 복사해 쓴다.
 * 기존 닉네임·SOOP 아이디 입력칸은 그대로 두고(신청 코드 수정 없음) 기본으로 숨긴 뒤,
 * 검색에서 고르면 그 칸에 값을 채운다. "직접 입력하기"로 언제든 기존 칸을 열 수 있다.
 *
 * 사용: window.attachSoopVerifySearch({
 *   nicknameInput: 'id 또는 요소', soopIdInput: 'id 또는 요소',
 *   search: async (query) => [{ nickname, soopId, avatarUrl }],
 *   steps: {                       // 선택: 주식시장처럼 한 화면에 한 단계씩(검색 → 선택 확인 → 쪽지 안내)
 *     root: 모달 요소,              // 열기·닫기·단계 변화를 감지할 범위
 *     isPending: () => boolean,     // 신청 접수(쪽지 안내) 단계인지
 *     afterSelect: [요소],          // 고른 뒤(또는 직접 입력)에만 보일 것: 신청 버튼 등
 *     pendingOnly: [요소],          // 쪽지 안내 단계에만 보일 것: 승인 확인 버튼 등
 *     hideAlways: [요소],           // 검색 방식에서 필요 없는 것
 *   },
 * });
 */
(function () {
  'use strict';
  if (window.attachSoopVerifySearch) return;

  var STYLE_ID = 'svs-style';
  var CSS = [
    '.svs-box{display:flex;flex-direction:column;gap:6px;margin:0 0 10px;text-align:left}',
    '.svs-label{font-size:13px;font-weight:700}',
    '.svs-input{box-sizing:border-box;width:100%;min-height:40px;padding:8px 11px;border:1px solid rgba(127,127,127,.45);border-radius:10px;background:inherit;color:inherit;font:inherit;font-size:14px}',
    '.svs-results{list-style:none;margin:0;padding:4px;max-height:240px;overflow-y:auto;border:1px solid rgba(127,127,127,.35);border-radius:10px}',
    '.svs-results[hidden],.svs-selected[hidden],.svs-hidden{display:none!important}',
    '.svs-item{display:flex;align-items:center;gap:10px;width:100%;padding:7px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
    '.svs-item:hover,.svs-item:focus-visible{background:rgba(127,127,127,.16);outline:none}',
    '.svs-avatar{flex:0 0 auto;width:34px;height:34px;border-radius:50%;object-fit:cover;background:#475569}',
    '.svs-text{display:flex;flex-direction:column;min-width:0}',
    '.svs-text strong{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.svs-text span{font-size:12px;opacity:.7}',
    '.svs-hint{margin:0;min-height:1em;font-size:12px;opacity:.75}',
    '.svs-selected{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid rgba(127,127,127,.45);border-radius:10px}',
    '.svs-selected .svs-text{flex:1}',
    '.svs-link{align-self:flex-end;margin:-2px 0 0;padding:2px 0;border:0;background:none;color:inherit;font:inherit;font-size:11px;font-weight:400;text-decoration:underline;opacity:.6;cursor:pointer}.svs-link:hover{opacity:.9}',
    '.svs-btn{flex:0 0 auto;padding:6px 10px;border:1px solid rgba(127,127,127,.45);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
  ].join('');
  var PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><circle cx="18" cy="18" r="18" fill="#475569"/><circle cx="18" cy="14" r="6" fill="#cbd5e1"/><path d="M6 32c2-7 8-9 12-9s10 2 12 9z" fill="#cbd5e1"/></svg>');
  var ID_RE = /^[a-z0-9]{2,20}$/;

  function el(ref) { return typeof ref === 'string' ? document.getElementById(ref) : ref; }
  function make(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }
  function setAvatar(img, item) {
    var id = String(item.soopId || '').toLowerCase();
    var queue = [];
    if (ID_RE.test(id)) queue.push('https://stimg.sooplive.com/LOGO/' + id.slice(0, 2) + '/' + id + '/' + id + '.jpg');
    if (item.avatarUrl && queue.indexOf(item.avatarUrl) < 0 && /^https:\/\//.test(item.avatarUrl)) queue.push(item.avatarUrl);
    img.onerror = function () {
      if (queue.length) { img.src = queue.shift(); return; }
      img.onerror = null;
      img.src = PLACEHOLDER;
    };
    img.src = queue.length ? queue.shift() : PLACEHOLDER;
  }
  function textBlock(item) {
    var text = make('span', 'svs-text');
    text.appendChild(make('strong', '', item.nickname));
    text.appendChild(make('span', '', item.soopId));
    return text;
  }
  // 입력칸과 그 이름표(감싸는 label 또는 for로 연결된 label)를 함께 숨기거나 보인다.
  function fieldParts(input) {
    var parts = [];
    var wrap = input.closest('label');
    if (wrap) return [wrap];
    parts.push(input);
    if (input.id) {
      var labels = document.querySelectorAll('label[for="' + input.id + '"]');
      for (var i = 0; i < labels.length; i += 1) parts.push(labels[i]);
    }
    return parts;
  }
  function fire(input) {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  window.attachSoopVerifySearch = function (options) {
    var nickInput = el(options && options.nicknameInput);
    var idInput = el(options && options.soopIdInput);
    var search = options && options.search;
    if (!nickInput || !idInput || typeof search !== 'function' || nickInput.dataset.svsAttached) return null;
    nickInput.dataset.svsAttached = '1';
    if (!document.getElementById(STYLE_ID)) {
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    var manualParts = fieldParts(nickInput).concat(fieldParts(idInput));
    var box = make('div', 'svs-box');
    var searchWrap = make('div', 'svs-box');
    searchWrap.style.margin = '0';
    var inputId = 'svs-input-' + Math.random().toString(36).slice(2, 8);
    var label = make('label', 'svs-label', '스트리머 검색');
    label.htmlFor = inputId;
    var input = make('input', 'svs-input');
    input.id = inputId;
    input.type = 'search';
    input.maxLength = 40;
    input.autocomplete = 'off';
    input.placeholder = '닉네임 또는 SOOP 아이디 (2자 이상)';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    var list = make('ul', 'svs-results');
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    var hint = make('p', 'svs-hint');
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');
    searchWrap.appendChild(label);
    searchWrap.appendChild(input);
    searchWrap.appendChild(list);
    searchWrap.appendChild(hint);

    var selected = make('div', 'svs-selected');
    selected.hidden = true;
    var selectedAvatar = make('img', 'svs-avatar');
    selectedAvatar.alt = '';
    selectedAvatar.referrerPolicy = 'no-referrer';
    var selectedText = make('span', 'svs-text');
    var reselect = make('button', 'svs-btn', '다시 선택');
    reselect.type = 'button';
    selected.appendChild(selectedAvatar);
    selected.appendChild(selectedText);
    selected.appendChild(reselect);

    var toggle = make('button', 'svs-link', '찾는 스트리머가 없나요? 직접 입력하기');
    toggle.type = 'button';
    box.appendChild(searchWrap);
    box.appendChild(selected);
    box.appendChild(toggle);
    manualParts[0].parentNode.insertBefore(box, manualParts[0]);

    var manual = false;
    var timer = 0;
    var sequence = 0;
    function setManual(on) {
      manual = on;
      manualParts.forEach(function (node) { node.classList.toggle('svs-hidden', !on); });
      searchWrap.classList.toggle('svs-hidden', on || !selected.hidden);
      if (on) selected.hidden = true;
      toggle.textContent = on ? '검색으로 돌아가기' : '찾는 스트리머가 없나요? 직접 입력하기';
      if (on) nickInput.focus({ preventScroll: true });
    }
    function clearResults(message) {
      while (list.firstChild) list.removeChild(list.firstChild);
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      hint.textContent = message || '';
    }
    function choose(item) {
      nickInput.value = item.nickname;
      idInput.value = item.soopId;
      fire(nickInput);
      fire(idInput);
      while (selectedText.firstChild) selectedText.removeChild(selectedText.firstChild);
      selectedText.appendChild(textBlock(item));
      setAvatar(selectedAvatar, item);
      selected.hidden = false;
      searchWrap.classList.add('svs-hidden');
      clearResults();
      applyStep();
    }
    function reset() {
      selected.hidden = true;
      searchWrap.classList.remove('svs-hidden');
      nickInput.value = '';
      idInput.value = '';
      fire(nickInput);
      fire(idInput);
      applyStep();
      input.focus({ preventScroll: true });
    }
    function render(streamers) {
      clearResults();
      streamers.forEach(function (item) {
        var row = make('li');
        row.setAttribute('role', 'option');
        var button = make('button', 'svs-item');
        button.type = 'button';
        var avatar = make('img', 'svs-avatar');
        avatar.alt = '';
        avatar.width = 34;
        avatar.height = 34;
        avatar.loading = 'lazy';
        avatar.referrerPolicy = 'no-referrer';
        setAvatar(avatar, item);
        button.appendChild(avatar);
        button.appendChild(textBlock(item));
        button.addEventListener('click', function () { choose(item); });
        row.appendChild(button);
        list.appendChild(row);
      });
      list.hidden = streamers.length === 0;
      input.setAttribute('aria-expanded', String(streamers.length > 0));
    }
    function run(query) {
      var mine = ++sequence;
      hint.textContent = '검색하고 있어요…';
      Promise.resolve().then(function () { return search(query); }).then(function (rows) {
        if (mine !== sequence) return;
        var streamers = (Array.isArray(rows) ? rows : []).filter(function (item) {
          return item && typeof item.nickname === 'string' && item.nickname && ID_RE.test(String(item.soopId || ''));
        }).slice(0, 20);
        render(streamers);
        hint.textContent = streamers.length
          ? streamers.length + '명을 찾았어요. 본인을 선택해 주세요.'
          : '검색 결과가 없어요. 닉네임이나 아이디를 확인하거나 직접 입력해 주세요.';
      }).catch(function (error) {
        if (mine !== sequence) return;
        var code = String(error && error.code || '');
        clearResults(/resource-exhausted/.test(code)
          ? '검색이 너무 잦아요. 잠시 후 다시 시도해 주세요.'
          : '검색을 불러오지 못했어요. 아래의 직접 입력하기를 이용해 주세요.');
      });
    }

    input.addEventListener('input', function () {
      clearTimeout(timer);
      sequence += 1;
      var query = input.value.trim();
      if (query.length < 2) { clearResults(query ? '두 글자 이상 입력해 주세요.' : ''); return; }
      timer = setTimeout(function () { run(query); }, 350);
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') event.preventDefault();
      if (event.key === 'ArrowDown') {
        var first = list.querySelector('button');
        if (first) { event.preventDefault(); first.focus(); }
      }
    });
    list.addEventListener('keydown', function (event) {
      var buttons = Array.prototype.slice.call(list.querySelectorAll('button'));
      var index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); buttons[Math.min(index + 1, buttons.length - 1)].focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); (index === 0 ? input : buttons[index - 1]).focus(); }
      else if (event.key === 'Escape') { event.preventDefault(); input.focus(); }
    });
    // 단계 전환: 상태가 바뀔 때만 class를 고쳐 MutationObserver가 되먹임 루프에 빠지지 않게 한다.
    var steps = (options && options.steps) || {};
    function setHidden(node, hide) {
      node = el(node);
      if (node && node.classList.contains('svs-hidden') !== hide) node.classList.toggle('svs-hidden', hide);
    }
    function applyStep() {
      var pending = typeof steps.isPending === 'function' && !!steps.isPending();
      if (!pending && !manual && !selected.hidden && !nickInput.value && !idInput.value) {
        // 사이트가 창을 다시 열며 입력값을 비우면 검색 단계로 돌아간다.
        selected.hidden = true;
        setHidden(searchWrap, false);
        input.value = '';
        clearResults();
      }
      setHidden(box, pending);
      manualParts.forEach(function (node) { setHidden(node, pending || !manual); });
      var chosen = manual || !selected.hidden;
      (steps.afterSelect || []).forEach(function (node) { setHidden(node, pending || !chosen); });
      (steps.pendingOnly || []).forEach(function (node) { setHidden(node, !pending); });
      (steps.hideAlways || []).forEach(function (node) { setHidden(node, true); });
    }
    var stepTimer = 0;
    function queueStep() {
      if (stepTimer) return;
      stepTimer = setTimeout(function () { stepTimer = 0; applyStep(); }, 0);
    }
    var stepRoot = el(steps.root);
    if (stepRoot && typeof MutationObserver === 'function') {
      new MutationObserver(queueStep).observe(stepRoot, {
        subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'],
      });
    }
    toggle.addEventListener('click', function () { setManual(!manual); applyStep(); });
    // 숨긴 입력칸이 required여도 신청 버튼이 조용히 멈추지 않게, 고르지 않고 신청하면 검색칸으로 안내한다.
    var form = nickInput.form;
    if (form) {
      form.addEventListener('submit', function (event) {
        if (manual || !selected.hidden || (nickInput.value.trim() && idInput.value.trim())) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        hint.textContent = '스트리머를 검색해 본인을 선택해 주세요.';
        input.focus({ preventScroll: true });
      }, true);
      [nickInput, idInput].forEach(function (field) {
        field.addEventListener('invalid', function (event) {
          if (manual) return;
          event.preventDefault();
          hint.textContent = '스트리머를 검색해 본인을 선택해 주세요.';
          input.focus({ preventScroll: true });
        });
      });
    }
    reselect.addEventListener('click', reset);
    setManual(false);
    applyStep();

    return {
      // 신청 화면을 다시 열 때 처음 상태(검색)로 되돌린다.
      reset: function () {
        if (manual) setManual(false);
        if (!selected.hidden || nickInput.value || idInput.value) reset();
        input.value = '';
        clearResults();
      },
    };
  };
})();
