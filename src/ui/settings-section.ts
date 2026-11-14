/**
 * 把「扩展」分区插进老设置弹窗。
 *
 * 老设置页是静态 DOM + 一次性绑定的按钮监听；这里不去改 app-actions.js，
 * 而是自己插一个按钮 + 一个 section，并复刻它的 active 切换语义。
 * 好处是：老设置页哪怕以后重构，插件内核这一块也不会跟着碎。
 */
import { renderExtensionPane } from './extension-settings';
import { host } from '../core/runtime';
import { configuration } from '../core/config';

const SECTION_KEY = 'extensions';
let installed = false;

function activateSection(key: string): void {
  document.querySelectorAll('.settings-nav-btn').forEach((node) => {
    node.classList.toggle('active', (node as HTMLElement).dataset.settingsNav === key);
  });
  document.querySelectorAll('.settings-section').forEach((node) => {
    node.classList.toggle('active', (node as HTMLElement).dataset.settingsPanel === key);
  });
}

export function installSettingsSection(): void {
  if (installed) return;
  const nav = document.getElementById('settingsNav');
  const detail = document.getElementById('settingsDetail');
  if (!nav || !detail) return;
  if (nav.querySelector(`[data-settings-nav="${SECTION_KEY}"]`)) {
    installed = true;
    return;
  }

  const button = document.createElement('button');
  button.className = 'settings-nav-btn';
  button.dataset.settingsNav = SECTION_KEY;
  button.innerHTML = '<span class="settings-nav-icon">✳</span>扩展与插件';

  const section = document.createElement('section');
  section.className = 'settings-section';
  section.dataset.settingsPanel = SECTION_KEY;

  const head = document.createElement('div');
  head.className = 'settings-section-head';
  const copy = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = '扩展与插件';
  const desc = document.createElement('p');
  desc.textContent = '已发现的扩展、启停状态与它们声明的配置项。扩展抛错不会影响地面站本体。';
  copy.append(title, desc);
  head.appendChild(copy);
  section.appendChild(head);

  const mount = document.createElement('div');
  mount.style.cssText = 'height:min(520px,58vh);display:flex;min-height:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:10px';
  section.appendChild(mount);

  let rendered = false;
  const render = () => {
    renderExtensionPane(mount);
    rendered = true;
  };

  button.addEventListener('click', () => {
    activateSection(SECTION_KEY);
    render();
  });

  // 扩展状态/配置变了要刷新，但只在分区可见时才画，避免后台白白重排
  const refreshIfVisible = () => {
    if (!rendered || !section.classList.contains('active')) return;
    renderExtensionPane(mount);
  };
  host.onDidChange(refreshIfVisible);
  configuration.onDidChange(refreshIfVisible);

  const anchor = nav.querySelector('.settings-nav-btn.desktop-only');
  if (anchor && anchor.parentElement === nav) nav.insertBefore(button, anchor);
  else nav.appendChild(button);
  detail.appendChild(section);
  installed = true;
}
