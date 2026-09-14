const MENU = [
  {
    title: '운영',
    children: [
      { title: '야놀자 프로세스 전체', href: '/nol/process/yanolja-process-overview.html' },
    ],
  },
  { title: 'IMG Config 신규 세팅' },
  { title: '프로젝트' },
  {
    title: '프로세스 고도화',
    children: [
      {
        title: '사입 프로세스 고도화',
        children: [
          { title: '엔터 티켓 사입(매입,매출) 프로세스 적용', href: '/nol/process/entertainment-ticket.html' },
          { title: 'MD(실물자산) 사입(매입,매출) 프로세스 적용', href: '/nol/process/md-inventory.html' },
          { title: '결합상품 사입 수기 업로드(숙소,이용권,티켓,MD) 구조 개선', href: '/nol/process/combined-product-upload.html' },
        ],
      },
    ],
  },
];

function buildMenu(container, items, depth = 0, prefix = '') {
  items.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = 'menu-item';

    // 대분류(depth 0)는 순번 없이, 그 아래부터 1. / 1.1. 식으로 계층 번호를 붙인다
    const num = depth === 0 ? '' : (prefix ? `${prefix}.${idx + 1}` : `${idx + 1}`);
    const label = num ? `${num}. ${item.title}` : item.title;

    const hasChildren = Array.isArray(item.children) && item.children.length > 0;

    if (hasChildren) {
      li.classList.add('open');

      const btn = document.createElement('button');
      btn.className = 'menu-btn';
      btn.innerHTML = `<span>${label}</span><span class="chevron">▶</span>`;
      btn.addEventListener('click', () => li.classList.toggle('open'));
      li.appendChild(btn);

      const submenu = document.createElement('ul');
      submenu.className = 'submenu';
      buildMenu(submenu, item.children, depth + 1, num);
      li.appendChild(submenu);
    } else {
      const a = document.createElement('a');
      a.className = 'leaf-link';
      a.href = item.href || '#';
      a.textContent = label;
      li.appendChild(a);
    }

    container.appendChild(li);
  });
}

buildMenu(document.getElementById('menuList'), MENU);
