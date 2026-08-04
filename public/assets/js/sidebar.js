const MENU = [
  { title: '운영' },
  { title: 'IMG Config 신규 세팅' },
  { title: '프로젝트' },
  {
    title: '프로세스 고도화',
    children: [
      {
        title: '사입 프로세스 고도화',
        children: [
          { title: '엔터 공연/콘서트 티켓', href: '/process/entertainment-ticket.html' },
          { title: '글로벌사업 BM 숙소, MD, 이용권, 티켓 사입' },
          { title: 'MD 실물자산 사입' },
          { title: '국내호텔 사입' },
        ],
      },
    ],
  },
];

function buildMenu(container, items, depth = 0) {
  items.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = 'menu-item';

    // 중분류(대분류 바로 하위) 메뉴만 순번을 붙여 구분
    const label = depth === 1 ? `${idx + 1}. ${item.title}` : item.title;

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
      buildMenu(submenu, item.children, depth + 1);
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
