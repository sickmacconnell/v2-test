'use client';
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Head from 'next/head'; // 🟢 引入 Head 组件控制浏览器标签
import { useRouter } from 'next/router';
import { GalleryManager } from './GalleryManager';
import { AttachmentManager } from './AttachmentManager';
import { GalleryStorageBar } from './GalleryStorageBar';
import {
  flushGalleryUploads,
  revokePendingGalleryItems,
  countPendingGalleryItems,
} from '@/src/lib/admin/galleryFlush';
import { uploadImageToLsky } from '@/src/lib/admin/lskyClientUpload';
import {
  createPendingImageBlock,
  countPendingEditorMedia,
  flushEditorBlocksMedia,
  isLockImagePending,
  isImageBlockPending,
  revokeBlockPendingMedia,
  revokePendingEditorMedia,
  blocksToMarkdown,
  findCoverImageBlock,
  clearManualCoverFlags,
  hasEditorImageBlock,
  isVideoImageContent,
  serializeBlocksForSave,
} from '@/src/lib/admin/contentMediaFlush';
import {
  applyBodyCoverSelection,
  applyDefaultCoverToggle,
  applyGalleryCoverSelection,
  applyManualCoverUrl,
  clearBodyCoverSelection,
  clearGalleryCoverFlags,
  COVER_MODE_AUTO,
  COVER_MODE_BODY,
  COVER_MODE_DEFAULT,
  COVER_MODE_URL,
  createInitialCoverSettings,
  resolveEditorBodyCoverBlockId,
  resolveEditorGalleryCoverIndex,
  resolveNotionCoverForSave,
  restoreEditorCoverState,
  formatEditorCoverStatus,
  clearGalleryCoverSelection,
} from '@/src/lib/admin/coverSettings';
import { remoteFromApiImage } from '@/src/lib/admin/galleryFlush';
import CardCategoryQuickPicker from './CardCategoryQuickPicker';
// 派工单 B3:后台「数据统计」面板(独立文件,AdminDashboard 只做引入与视图接线)
import StatsPanel from './StatsPanel';
import { FiBarChart2 } from 'react-icons/fi';
import {
  createEditorBlock,
  getEditorBlockLockPwd,
  isEditorBlockLocked,
  normalizeLoadedEditorBlocks,
} from '@/src/lib/admin/editorBlockLock';
import { generateAdminPostSlug } from '@/src/lib/blog/generateAdminPostSlug';
import {
  saveEditorDraftSnapshot,
  loadEditorDraftSnapshot,
  listEditorDraftSnapshots,
  removeEditorDraftSnapshot,
  clearEditorDraftSnapshotsForPost,
} from '@/src/lib/admin/editorDraftSnapshot';
import {
  BLOG_SHELL_REFRESH_COOLDOWN_MS,
  executeListMutationWithProgress,
  runBatchedRevalidation,
  runThemeRevalidation,
  showRevalidateFeedback,
  triggerContentRevalidation,
  triggerShellBlogRefresh,
} from './adminRevalidateClient';

/** 后台分类下拉中隐藏且不可删改的系统保留分类 */
const PROTECTED_CATEGORIES = new Set(['网站信息', '系统组件', '站长通知']);

/** 删除分类后文章自动归入的兜底分类（下拉可见、可选，但不可删除/重命名） */
const FALLBACK_CATEGORY = '未分类';

const isProtectedCategory = (name) =>
  PROTECTED_CATEGORIES.has((name || '').trim());

const isFallbackCategory = (name) =>
  (name || '').trim() === FALLBACK_CATEGORY;

const isSystemReservedCategory = (name) =>
  isProtectedCategory(name) || isFallbackCategory(name);

const SPECIAL_PAGE_SLUGS = new Set(['announcement', 'about', 'download', 'theme-config', 'social-links']);
const SHOW_VENDING_ADDRESS_ADMIN = true;
const SOCIAL_LINK_PLATFORMS = [
  { platform: 'weibo', label: '微博', placeholder: 'https://weibo.com/...' },
  { platform: 'twitter', label: 'Twitter / X', placeholder: 'https://x.com/...' },
  { platform: 'pixiv', label: 'Pixiv', placeholder: 'https://www.pixiv.net/users/...' },
  { platform: 'telegram', label: 'Telegram', placeholder: 'https://t.me/...' },
  { platform: 'instagram', label: 'Instagram', placeholder: 'https://instagram.com/...' },
];

function resolveSaveRevalidateScope(type, slug) {
  if (type === 'Widget') {
    if (slug === 'gallery-ad') return 'gallery-ad';
    if (slug === 'vending') return 'vending';
    if (slug === 'announcement-popup') return 'announcement-popup';
    if (slug === 'popup-ad') return 'popup-ad';
    if (slug === 'click-ad') return 'click-ad';
    if (slug === 'social-links') return 'social-links';
    if (slug === 'banner') return 'banner';
    return 'widget';
  }
  if (type === 'Page' || SPECIAL_PAGE_SLUGS.has(slug)) {
    return 'page';
  }
  return 'post';
}

/** 发布队列：各阶段「无进度心跳」超过此时长才视为卡住（非总时长） */
const PUBLISH_QUEUE_IDLE_STALL_MS = {
  gallery: 180_000,
  media: 120_000,
  post: 90_000,
  refresh: 120_000,
  default: 120_000,
};

function resolvePublishIdleStallMs(job) {
  const ms = PUBLISH_QUEUE_IDLE_STALL_MS[job?.phase];
  return typeof ms === 'number' ? ms : PUBLISH_QUEUE_IDLE_STALL_MS.default;
}

/** 前台刷新冷却提示：<60s 显示秒，≥60s 显示分钟 */
function formatRefreshCooldownHint(sec) {
  const s = Math.max(0, Math.ceil(Number(sec) || 0));
  return s >= 60 ? `${Math.round(s / 60)} 分钟` : `${s} 秒`;
}

function hasGalleryImageItem(items) {
  return (items || []).some(
    (item) =>
      item?.status === 'pending' ||
      (item?.status === 'remote' && typeof item.url === 'string' && item.url.trim())
  );
}

function formatJobElapsed(startedAt) {
  if (!startedAt) return '';
  const sec = Math.floor((Date.now() - startedAt) / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `${min} 分 ${rem} 秒` : `${min} 分`;
}
/** 发布 API 请求超时 */
const PUBLISH_POST_FETCH_TIMEOUT_MS = 90_000;
/** 爬虫入库：Notion + 图库 + 多页 revalidate，允许较长等待 */
const CRAWLER_INGEST_FETCH_TIMEOUT_MS = 300_000;
const CRAWLER_INGEST_POLL_MS = 2500;
const PUBLISH_QUEUE_META_KEY = 'admin_publish_queue_meta';

async function fetchWithTimeout(url, options = {}, timeoutMs = PUBLISH_POST_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error('请求超时，请检查网络后重试');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ================= 1. 图标库 =================
const Icons = {
  Search: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>,
  Edit: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4L18.5 2.5z"></path></svg>,
  Trash: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>,
  Restore: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  ),
  Pin: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="9" />
      <polyline points="8 13 12 9 16 13" />
      <line x1="7" y1="5" x2="17" y2="5" />
    </svg>
  ),
  Star: ({ filled = false } = {}) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  ),
  Settings: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>,
  ArrowUp: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="18 15 12 9 6 15"></polyline></svg>,
  ArrowDown: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>,
  Top: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="18 11 12 5 6 11"></polyline><polyline points="18 18 12 12 6 18"></polyline></svg>,
  Bottom: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 6 12 12 18 6"></polyline><polyline points="6 13 12 19 18 13"></polyline></svg>,
  Refresh: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>,
  FolderIcon: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="#ffffff" style={{opacity:0.8}}><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"></path></svg>,
  ChevronDown: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"></polyline></svg>,
  FolderMode: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>,
  CoverMode: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>,
  TextMode: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>,
  GridMode: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>,
  Calendar: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>,
  Tutorial: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
};

// ================= 2. 全局样式 =================
const GlobalStyle = () => (
  <style dangerouslySetInnerHTML={{__html: `
    body { background-color: #303030; color: #ffffff; margin: 0; font-family: system-ui, sans-serif; overflow-x: hidden; }
    .card-item { position: relative; background: #424242; border-radius: 12px; margin-bottom: 12px; border: 1px solid transparent; cursor: pointer; transition: 0.3s; overflow: hidden; display: flex !important; flex-direction: row !important; align-items: stretch; }
    .card-item:hover { border-color: greenyellow; transform: translateY(-2px); background: #4d4d4d; box-shadow: 0 0 10px rgba(173, 255, 47, 0.1); }
    .drawer { position: absolute; right: -240px; top: 0; bottom: 0; width: 240px; display: flex; transition: 0.3s cubic-bezier(0.4, 0, 0.2, 1); z-index: 10; }
    .card-item:hover .drawer { right: 0; }
    .pin-divider { display: flex; align-items: center; gap: 12px; margin: 16px 0 20px; color: #888; font-size: 11px; letter-spacing: 0.5px; }
    .pin-divider::before, .pin-divider::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, transparent, #666, transparent); }
    .pin-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; background: rgba(251, 191, 36, 0.2); color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.45); margin-right: 6px; }
    .dr-btn { flex: 1; display: flex; align-items: center; justify-content: center; color: #fff; transition: 0.2s; }
    .dr-btn.is-loading { pointer-events: none; cursor: wait; }
    .dr-btn-spin { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.25); border-top-color: #fbbf24; border-radius: 50%; animation: imgspin 0.8s linear infinite; flex: none; }
    .admin-list-tabs { background: #424242; padding: 4px; border-radius: 12px; display: flex; flex-wrap: nowrap; align-items: center; gap: 2px; flex-shrink: 0; }
    .admin-list-tab { padding: 7px 12px; border: none; background: none; color: #888; border-radius: 8px; font-weight: bold; font-size: 12px; cursor: pointer; white-space: nowrap; flex-shrink: 0; line-height: 1; display: inline-flex; align-items: center; gap: 5px; }
    .admin-list-tab.is-active { background: #555; color: #fff; }
    .admin-list-tab-count { font-size: 10px; font-weight: 800; line-height: 1; }
    .admin-list-tab-count.is-published { color: #adff2f; }
    .admin-list-tab-count.is-published-idle { color: #666; }
    .admin-list-tab-count.is-favourites { color: #fbbf24; }
    .admin-list-tab-count.is-favourites-idle { color: #666; }
    .admin-list-head-left { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 12px; flex: 1; min-width: 0; }
    .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(4px); }
    .modal-box { background: #202024; width: 90%; maxWidth: 900px; height: 90vh; border-radius: 24px; border: 1px solid #333; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
    .modal-body { flex: 1; overflow-y: auto; padding: 40px; scroll-behavior: smooth; }
    input, select, textarea { width: 100%; padding: 14px; background: #18181c; border: 1px solid #333; border-radius: 10px; color: #fff; box-sizing: border-box; font-size: 15px; outline: none; transition: 0.3s; }
    .glow-input:focus, .glow-input:hover { border-color: greenyellow; box-shadow: 0 0 12px rgba(173, 255, 47, 0.3); background: #1f1f23; }
    .glow-input:disabled, .glow-input:disabled:hover { border-color:#333; box-shadow:none; background:#161619; color:#777; cursor:not-allowed; }
    .tag-chip { background: #333; padding: 4px 10px; border-radius: 4px; font-size: 11px; color: #bbb; margin: 0 5px 5px 0; cursor: pointer; position: relative; }
    .tag-del { position: absolute; top: -5px; right: -5px; background: #ff4d4f; color: white; border-radius: 50%; width: 14px; height: 14px; display: none; align-items: center; justify-content: center; font-size: 10px; }
    .tag-chip:hover .tag-del { display: flex; }
    .tag-suggest-chip { position: relative; cursor: pointer; background: #2a2a2e; border: 1px solid #444; color: #bbb; padding: 4px 10px; border-radius: 6px; font-size: 12px; }
    .tag-suggest-chip:hover { border-color: #666; color: #ddd; }
    .tag-suggest-del { position: absolute; top: -6px; right: -6px; background: #ff4d4f; color: #fff; border-radius: 50%; width: 14px; height: 14px; display: flex; align-items: center; justify-content: center; font-size: 10px; line-height: 1; cursor: pointer; z-index: 1; border: 1px solid #303030; }
    .category-perm-del { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; margin-left: 6px; border-radius: 6px; border: 1px solid rgba(255,77,79,0.45); background: rgba(255,77,79,0.12); color: #ff7875; cursor: pointer; flex-shrink: 0; transition: 0.2s; }
    .category-perm-del:hover { background: rgba(255,77,79,0.28); color: #fff; }
    .category-edit-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; margin-left: 6px; border-radius: 6px; border: 1px solid rgba(125,211,252,0.45); background: rgba(125,211,252,0.12); color: #7dd3fc; cursor: pointer; flex-shrink: 0; transition: 0.2s; font-size: 11px; font-weight: 800; padding: 0; }
    .category-edit-btn:hover { background: rgba(125,211,252,0.28); color: #fff; }
    .category-dropdown-row { display: flex; align-items: stretch; border-bottom: 1px solid #3a3a3f; }
    .category-dropdown-pick { flex: 1; display: block; text-align: left; padding: 10px 14px; border: none; background: transparent; color: #eee; font-size: 13px; cursor: pointer; }
    .category-dropdown-del { width: 40px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border: none; border-left: 1px solid #3a3a3f; background: transparent; color: #ff7875; cursor: pointer; transition: 0.2s; }
    .category-dropdown-del:hover { background: rgba(255,77,79,0.15); color: #ff4d4f; }
    .card-cat-chip { position: relative; z-index: 11; display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 4px; border: 1px solid #555; background: #3a3a3f; color: #ddd; font-size: 11px; line-height: 18px; cursor: pointer; transition: 0.2s; vertical-align: middle; }
    .card-cat-chip:hover { background: #4a4a50; border-color: #888; color: #fff; }
    .card-cat-chip-text.is-uncat { color: #999; }
    .card-cat-chip svg { flex-shrink: 0; }
    .card-cat-qp-row { flex: 1; display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; padding: 9px 14px; border: none; background: transparent; color: #eee; font-size: 13px; cursor: pointer; }
    .card-cat-qp-row:hover { background: rgba(255,255,255,0.05); }
    .card-cat-qp-row.is-active { background: rgba(173,255,47,0.12); color: greenyellow; }
    .card-cat-qp-row.is-active:hover { background: rgba(173,255,47,0.18); }
    .category-folder-card { position: relative; transition: background 0.2s, border-color 0.2s, box-shadow 0.2s, transform 0.15s; }
    .category-folder-card:hover { background: #4a4a50 !important; border-color: #8a8a90 !important; box-shadow: 0 4px 14px rgba(0,0,0,0.35); transform: translateY(-1px); }
    .category-folder-del { position: absolute; top: 50%; right: 8px; transform: translateY(-50%); width: 26px; height: 26px; display: none; align-items: center; justify-content: center; border-radius: 6px; border: 1px solid rgba(255,77,79,0.45); background: rgba(255,77,79,0.12); color: #ff7875; cursor: pointer; transition: 0.2s; }
    .category-folder-card:hover .category-folder-del { display: inline-flex; }
    .category-folder-del:hover { background: rgba(255,77,79,0.28); color: #fff; }
    .loader-overlay { position: fixed; inset: 0; background: rgba(20, 20, 23, 0.95); z-index: 9999; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(10px); flex-direction: column; padding: 24px; box-sizing: border-box; }
    .loader-text { margin-top: 20px; font-family: monospace; color: #888; font-size: 12px; letter-spacing: 2px; text-transform: uppercase; }
    .loader-phase { margin-top: 28px; font-size: 16px; font-weight: 600; color: #fff; text-align: center; letter-spacing: 0.5px; max-width: 520px; line-height: 1.45; }
    .loader-step { font-size: 12px; color: greenyellow; letter-spacing: 0.12em; margin-top: 8px; font-weight: 700; text-align: center; }
    .loader-detail { margin-top: 10px; font-size: 13px; color: greenyellow; text-align: center; min-height: 20px; }
    .loader-hint { margin-top: 8px; font-size: 11px; color: #666; text-align: center; max-width: 420px; line-height: 1.6; }
    .loader-lock-hint { font-size: 12px; color: #888; margin-top: 18px; text-align: center; max-width: 420px; line-height: 1.6; }
    .loader-progress-track { margin-top: 18px; width: min(320px, 80vw); height: 6px; background: #2a2a2e; border-radius: 999px; overflow: hidden; border: 1px solid #333; }
    .loader-progress-bar { height: 100%; background: linear-gradient(90deg, #adff2f, #84cc16); border-radius: 999px; transition: width 0.35s ease; }
    .pubq { position: fixed; top: 88px; right: 20px; z-index: 99998; width: min(360px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 8px; }
    .pubq-head { display: flex; align-items: center; justify-content: space-between; background: #18181c; border: 1px solid #333; border-radius: 10px; padding: 10px 14px; font-size: 13px; color: #bbb; letter-spacing: 0.2px; }
    .pubq-head b { color: #fff; font-size: 13px; font-weight: 700; }
    .pubq-list { display: flex; flex-direction: column; gap: 8px; max-height: calc(100vh - 120px); overflow-y: auto; padding-right: 2px; }
    .pubq-card { background: #202024; border: 1px solid #333; border-radius: 12px; padding: 12px 14px; box-shadow: 0 10px 28px rgba(0,0,0,0.45); }
    .pubq-card.is-err { border-color: rgba(255,77,79,0.5); }
    .pubq-card.is-ok { border-color: rgba(173,255,47,0.4); }
    .pubq-row { display: flex; align-items: center; gap: 8px; }
    .pubq-title { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.35; }
    .pubq-state { font-size: 12px; line-height: 1.4; color: #aaa; margin-top: 6px; }
    .pubq-actions { display: flex; align-items: center; gap: 6px; flex: none; }
    .pubq-x { background: none; border: none; color: #777; font-size: 18px; line-height: 1; cursor: pointer; padding: 2px 4px; width: auto; }
    .pubq-x:hover { color: #fff; }
    .pubq-retry { background: none; border: 1px solid #555; color: #ddd; font-size: 12px; border-radius: 6px; padding: 3px 10px; cursor: pointer; width: auto; }
    .pubq-retry:hover { border-color: greenyellow; color: greenyellow; }
    .pubq-spin { width: 14px; height: 14px; border: 2px solid #333; border-top-color: greenyellow; border-radius: 50%; animation: imgspin 0.8s linear infinite; flex: none; }
    .post-sync-banner { grid-column: 1 / -1; display: flex; align-items: center; gap: 12px; margin-bottom: 12px; padding: 14px 18px; border: 1px solid rgba(173,255,47,0.45); border-radius: 12px; background: linear-gradient(90deg, rgba(173,255,47,0.12), rgba(32,32,36,0.96)); color: #fff; }
    .post-sync-banner-title { font-size: 14px; font-weight: 700; }
    .post-sync-banner-detail { margin-top: 3px; color: #aaa; font-size: 12px; line-height: 1.45; }
    .pubq-detail { margin-top: 8px; font-size: 12px; color: #999; line-height: 1.45; }
    .pubq-detail.is-err { color: #ff6b6d; word-break: break-word; }
    .pubq-bar-track { margin-top: 8px; height: 5px; background: #2a2a2e; border-radius: 999px; overflow: hidden; }
    .pubq-bar { height: 100%; background: linear-gradient(90deg, #adff2f, #84cc16); border-radius: 999px; transition: width 0.3s ease; }
    .pubq-bar.is-err { background: #ff4d4f; }
    .pubq-bar-indet { height: 100%; width: 40%; background: linear-gradient(90deg, #adff2f, #84cc16); border-radius: 999px; animation: pubqIndet 1.15s ease-in-out infinite; }
    .pubq-warn { flex: none; width: 14px; height: 14px; border-radius: 50%; background: #fbbf24; color: #1a1a1a; font-size: 10px; font-weight: 800; line-height: 14px; text-align: center; }
    .pubq-stall-hint { margin-top: 8px; font-size: 12px; color: #fbbf24; line-height: 1.45; }
    .pubq-stall-row { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    @keyframes pubqIndet { 0% { margin-left: -42%; } 100% { margin-left: 102%; } }
    .loader { display: flex; margin: 0.25em 0; }
    .dash { animation: dashArray 2s ease-in-out infinite, dashOffset 2s linear infinite; }
    @keyframes dashArray { 0% { stroke-dasharray: 0 1 359 0; } 50% { stroke-dasharray: 0 359 1 0; } 100% { stroke-dasharray: 359 1 0 0; } }
    @keyframes dashOffset { 0% { stroke-dashoffset: 365; } 100% { stroke-dashoffset: 5; } }
    .animated-button { position: relative; display: flex; align-items: center; gap: 4px; padding: 12px 36px; border: 2px solid; border-color: transparent; font-size: 14px; background-color: inherit; border-radius: 100px; font-weight: 600; color: greenyellow; box-shadow: 0 0 0 2px greenyellow; cursor: pointer; overflow: hidden; transition: all 0.6s cubic-bezier(0.23, 1, 0.32, 1); }
    .animated-button svg { position: absolute; width: 20px; fill: greenyellow; z-index: 9; transition: all 0.8s cubic-bezier(0.23, 1, 0.32, 1); }
    .animated-button .arr-1 { right: 16px; }
    .animated-button .arr-2 { left: -25%; }
    .animated-button .circle { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 20px; height: 20px; background-color: greenyellow; border-radius: 50%; opacity: 0; transition: all 0.8s cubic-bezier(0.23, 1, 0.32, 1); }
    .animated-button .text { position: relative; z-index: 1; transform: translateX(-12px); transition: all 0.8s cubic-bezier(0.23, 1, 0.32, 1); }
    .animated-button:hover { box-shadow: 0 0 0 12px transparent; color: #212121; border-radius: 12px; }
    .animated-button:hover .arr-1 { right: -25%; }
    .animated-button:hover .arr-2 { left: 16px; }
    .animated-button:hover .text { transform: translateX(12px); }
    .animated-button:hover svg { fill: #212121; }
    .animated-button:active { scale: 0.95; box-shadow: 0 0 0 4px greenyellow; }
    .animated-button:hover .circle { width: 220px; height: 220px; opacity: 1; }
    .nav-container { position: relative; background: #202024; border-radius: 50px; padding: 5px; display: flex; align-items: center; gap: 5px; border: 1px solid #333; width: fit-content; }
    .nav-glider { position: absolute; top: 5px; bottom: 5px; background: greenyellow; border-radius: 40px; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); z-index: 1; }
    .nav-item { position: relative; z-index: 2; padding: 8px 16px; cursor: pointer; color: #888; transition: color 0.3s; display: flex; align-items: center; justify-content: center; width: 40px; }
    .nav-item.active { color: #000; font-weight: bold; }
    .gallery-only-tag { display: inline; color: #1a1500; font-weight: 600; background: linear-gradient(180deg, #ffe566 0%, #ffd400 100%); padding: 1px 7px; border-radius: 4px; font-size: 10px; letter-spacing: 0.3px; box-shadow: 0 0 0 1px rgba(255, 200, 0, 0.35); vertical-align: baseline; }
    .block-card-wrap { display: grid; grid-template-columns: 1fr 40px; column-gap: 4px; margin-bottom: 0; align-items: stretch; }
    .block-card { background: #2a2a2e; border: 1px solid #333; border-radius: 10px; padding: 15px 15px 15px 55px; margin-bottom: 0; position: relative; transition: border 0.2s; min-width: 0; }
    .block-card-wrap:hover .block-card { border-color: greenyellow; }
    .block-card.just-moved { animation: moveHighlight 0.6s ease-out; }
    @keyframes moveHighlight { 0% { box-shadow: 0 0 0 0 rgba(173, 255, 47, 0); border-color: #333; } 30% { box-shadow: 0 0 15px 2px rgba(173, 255, 47, 0.4); border-color: greenyellow; background: #2f2f33; } 100% { box-shadow: 0 0 0 0 rgba(173, 255, 47, 0); border-color: #333; background: #2a2a2e; } }
    .block-left-ctrl { position: absolute; left: 0; top: 0; bottom: 0; width: 45px; background: rgba(0,0,0,0.2); border-right: 1px solid #333; border-radius: 10px 0 0 10px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
    .move-btn { cursor: pointer; color: #888; width: 30px; height: 30px; border-radius: 6px; transition: 0.2s; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.05); }
    .move-btn:hover { background: greenyellow; color: #000; box-shadow: 0 0 10px greenyellow; }
    .move-btn:active { transform: scale(0.9); }
    .block-label { font-size: 12px; color: greenyellow; margin-bottom: 8px; fontWeight: bold; text-transform: uppercase; letter-spacing: 1px; }
    .block-label-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
    .block-label-row .block-label { margin-bottom: 0; flex: 1; min-width: 0; }
    .block-lock-btn { flex-shrink: 0; width: 32px; height: 32px; border-radius: 8px; border: 1px solid #444; background: #1c1c1f; color: #888; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font-size: 16px; line-height: 1; transition: border-color 0.15s, background 0.15s, color 0.15s, box-shadow 0.15s; }
    .block-lock-btn:hover { border-color: #fbbf24; color: #fbbf24; background: rgba(251, 191, 36, 0.08); }
    .block-lock-btn.is-active { border-color: #fbbf24; color: #fcd34d; background: rgba(251, 191, 36, 0.16); box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.25); }
    .block-card.is-locked { border-color: rgba(251, 191, 36, 0.35); box-shadow: inset 0 0 0 1px rgba(251, 191, 36, 0.12), 0 0 18px rgba(251, 191, 36, 0.06); }
    .block-card-wrap:hover .block-card.is-locked { border-color: rgba(251, 191, 36, 0.55); }
    .block-lock-hint { font-size: 11px; color: #fbbf24; background: rgba(251, 191, 36, 0.08); border: 1px dashed rgba(251, 191, 36, 0.35); border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; line-height: 1.5; }
    .block-minimap-lock { font-size: 10px; color: #fcd34d; background: rgba(251, 191, 36, 0.14); border: 1px solid rgba(251, 191, 36, 0.35); border-radius: 4px; padding: 1px 5px; line-height: 1.3; }
    .block-del { width: 40px; background: #ff4d4f; border-radius: 10px; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: opacity 0.2s; cursor: pointer; color: white; align-self: stretch; }
    .block-card-wrap:hover .block-del { opacity: 1; pointer-events: auto; }
    .block-add-btn-wrap { position: absolute; left: 50%; bottom: -52px; transform: translateX(-50%); z-index: 6; display: flex; flex-direction: column; align-items: center; }
    .block-add-btn-wrap.is-open { z-index: 10052; }
    .block-add-btn { position: relative; height: 36px; padding: 0 24px; border-radius: 10px; background: greenyellow; color: #000; display: inline-flex; align-items: center; gap: 6px; font-size: 14px; font-weight: bold; line-height: 1; cursor: pointer; box-shadow: 0 3px 12px rgba(0,0,0,0.4); transition: transform 0.15s, background 0.15s, box-shadow 0.15s; }
    .block-add-btn:hover { transform: translateY(-2px); background: #c4f74a; box-shadow: 0 5px 16px rgba(0,0,0,0.45); }
    .block-add-btn.open { background: #c4f74a; }
    .block-add-menu-backdrop { position: fixed; inset: 0; z-index: 10050; background: transparent; }
    .block-type-menu { background: #1f1f24; border: 1px solid #3a3a42; border-radius: 12px; padding: 8px; box-shadow: 0 12px 36px rgba(0,0,0,0.6); display: flex; flex-direction: column; gap: 4px; min-width: 210px; }
    .block-type-menu-floating { position: fixed; z-index: 10051; max-height: min(calc(100vh - 24px), 420px); overflow-y: auto; }
    .block-type-menu .bt-item { padding: 12px 18px; border-radius: 8px; font-size: 15px; color: #ddd; cursor: pointer; white-space: nowrap; transition: background 0.15s; line-height: 1.3; }
    .block-type-menu .bt-item:hover { background: #2f7cf6; color: #fff; }
    .block-empty-add { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; padding: 26px; border: 2px dashed #555; border-radius: 12px; background: transparent; color: #ccc; font-size: 15px; font-weight: bold; cursor: pointer; transition: border-color 0.2s, color 0.2s, background 0.2s, box-shadow 0.2s; }
    .block-empty-add:hover { border-color: greenyellow; color: greenyellow; }
    .block-empty-add.is-file-drop-target { border-color: greenyellow; color: greenyellow; background: rgba(173, 255, 47, 0.1); box-shadow: 0 0 0 2px rgba(173, 255, 47, 0.45), 0 0 28px rgba(173, 255, 47, 0.35), inset 0 0 48px rgba(173, 255, 47, 0.08); }
    .block-cover-hint { margin-bottom: 16px; font-size: 12px; color: #999; background: #202024; border-radius: 8px; padding: 12px 14px; line-height: 1.7; border: 1px solid #333; }
    .block-card-wrap.is-file-drop-before .block-card { border-color: greenyellow; box-shadow: inset 0 4px 0 0 greenyellow, 0 0 18px rgba(173, 255, 47, 0.4); }
    .block-card-wrap.is-file-drop-after .block-card { border-color: greenyellow; box-shadow: inset 0 -4px 0 0 greenyellow, 0 0 18px rgba(173, 255, 47, 0.4); }
    .block-minimap.is-file-drop-empty { border-color: greenyellow; box-shadow: 0 0 0 2px rgba(173, 255, 47, 0.35), inset 0 0 40px rgba(173, 255, 47, 0.06); }
    .block-view-toolbar { display: flex; align-items: center; justify-content: center; margin-bottom: 16px; }
    .block-view-toggle { display: inline-flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; }
    .block-minimap-toolbar { display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 12px; margin-bottom: 12px; flex-shrink: 0; }
    .block-compact-select-toggle { border: 1px solid #555; min-height: 38px; padding: 10px 22px; border-radius: 10px; display: inline-flex; justify-content: center; align-items: center; background: #1c1c1f; cursor: pointer; transition: all 0.2s ease; font-family: inherit; font-size: 13px; font-weight: bold; color: #ccc; white-space: nowrap; line-height: 1.2; }
    .block-compact-select-toggle:hover { border-color: greenyellow; color: greenyellow; background: rgba(173,255,47,0.08); }
    .block-compact-select-toggle.is-active { border-color: greenyellow; background: greenyellow; color: #000; box-shadow: 0 0 0 2px rgba(173,255,47,0.35), 0 0 18px rgba(173,255,47,0.3); }
    .block-compact-select-toggle.is-active:hover { background: #c4f74a; color: #000; }
    .block-compact-multiselect-del { border: none; border-radius: 10px; min-height: 38px; padding: 10px 22px; font-size: 13px; font-weight: bold; cursor: pointer; background: #ff4d4f; color: #fff; transition: background 0.15s, opacity 0.15s, transform 0.15s; white-space: nowrap; line-height: 1.2; }
    .block-compact-multiselect-del:hover:not(:disabled) { background: #ff7875; transform: translateY(-1px); }
    .block-compact-multiselect-del:disabled { opacity: 0.4; cursor: not-allowed; }
    .block-minimap-item.is-select-mode { cursor: pointer; }
    .block-minimap-item.is-select-mode:active { cursor: pointer; }
    .block-minimap-item.is-selected { border-color: greenyellow; box-shadow: 0 0 0 2px rgba(173,255,47,0.55), 0 0 18px rgba(173,255,47,0.3); }
    .block-minimap-item.is-selected::after { content: '✓'; position: absolute; bottom: 6px; right: 6px; width: 22px; height: 22px; border-radius: 50%; background: greenyellow; color: #000; font-size: 13px; font-weight: 800; display: flex; align-items: center; justify-content: center; z-index: 2; box-shadow: 0 2px 8px rgba(173,255,47,0.45); line-height: 1; }
    .block-view-toggle .view-mode-btn { border: none; min-width: 0; height: 2.1em; padding: 0 0.85em; border-radius: 999px; display: inline-flex; justify-content: center; align-items: center; gap: 5px; background: #1C1A1C; cursor: pointer; transition: all 450ms ease-in-out; font-family: inherit; }
    .block-view-toggle .view-mode-btn .view-mode-sparkle { width: 11px; height: 11px; fill: #AAAAAA; transition: all 800ms ease; flex-shrink: 0; }
    .block-view-toggle .view-mode-btn .view-mode-text { font-weight: 600; color: #AAAAAA; font-size: 11px; transition: color 450ms ease; white-space: nowrap; line-height: 1; }
    .block-view-toggle .view-mode-btn:hover, .block-view-toggle .view-mode-btn.is-active { background: linear-gradient(0deg,#A47CF3,#683FEA); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35), inset 0 -2px 0 rgba(0, 0, 0, 0.2), 0 0 0 2px rgba(255, 255, 255, 0.15), 0 0 28px rgba(153, 23, 255, 0.55); transform: translateY(-1px); }
    .block-view-toggle .view-mode-btn:hover .view-mode-text, .block-view-toggle .view-mode-btn.is-active .view-mode-text { color: white; }
    .block-view-toggle .view-mode-btn:hover .view-mode-sparkle, .block-view-toggle .view-mode-btn.is-active .view-mode-sparkle { fill: white; transform: scale(1.15); }
    .block-view-toggle .view-mode-btn:active { transform: translateY(0); }
    .block-minimap { display: flex; flex-direction: column; align-items: center; padding: 14px; background: #252528; border: 1px solid #333; border-radius: 12px; max-height: min(72vh, 680px); overflow: hidden; }
    .block-minimap-scroll { flex: 1; min-height: 0; width: 100%; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #555 #252528; }
    .block-minimap-scroll::-webkit-scrollbar { width: 8px; }
    .block-minimap-scroll::-webkit-scrollbar-track { background: #252528; border-radius: 4px; }
    .block-minimap-scroll::-webkit-scrollbar-thumb { background: #555; border-radius: 4px; }
    .block-minimap-scroll::-webkit-scrollbar-thumb:hover { background: #777; }
    .block-minimap-list { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 100%; }
    .block-minimap-add-wrap { position: relative; display: flex; justify-content: center; align-items: center; padding: 2px 0; flex-shrink: 0; width: 100%; }
    .block-minimap-add-btn { width: 34px; height: 34px; border-radius: 50%; border: 1px dashed #555; background: #1c1c1f; color: greenyellow; font-size: 20px; font-weight: 700; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: border-color 0.15s, background 0.15s, transform 0.15s, box-shadow 0.15s; box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
    .block-minimap-add-btn:hover, .block-minimap-add-btn.open { border-color: greenyellow; background: rgba(173,255,47,0.14); box-shadow: 0 3px 12px rgba(173,255,47,0.2); transform: scale(1.05); }
    .block-builder-shell { border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 14px; padding: 12px 10px 16px; box-sizing: border-box; background: rgba(255, 255, 255, 0.015); box-shadow: inset 0 0 24px rgba(255, 255, 255, 0.03), 0 8px 32px rgba(0, 0, 0, 0.35); transition: background-color 0.3s ease, border-color 0.3s ease; }
    .block-builder-shell:hover { border-color: rgba(255, 255, 255, 0.14); background-color: rgba(255, 255, 255, 0.025); }
    .block-builder-area-title { font-size: 15px; letter-spacing: 2px; color: rgba(255, 255, 255, 0.55); margin-bottom: 14px; user-select: none; display: flex; align-items: center; gap: 8px; }
    .block-builder-area-title::before { content: ''; width: 2px; height: 14px; border-radius: 2px; background: rgba(255, 255, 255, 0.25); flex-shrink: 0; }
    .block-builder-expanded { display: flex; flex-direction: column; gap: 72px; padding-bottom: 28px; }
    .block-minimap-item { position: relative; display: flex; flex-direction: column; width: 140px; min-height: 118px; flex-shrink: 0; border: 1px solid #444; border-radius: 8px; background: #1c1c1f; overflow: hidden; transition: border-color 0.15s, box-shadow 0.15s, opacity 0.15s; user-select: none; cursor: grab; touch-action: none; }
    .block-minimap-item:active { cursor: grabbing; }
    .block-minimap-item:hover { border-color: #666; }
    .block-minimap-item.is-dragging { opacity: 0.45; transform: scale(0.97); cursor: grabbing; }
    .block-minimap-item.is-drop-before { border-color: greenyellow; box-shadow: inset 0 3px 0 0 greenyellow, 0 0 0 1px rgba(173,255,47,0.35); }
    .block-minimap-item.is-drop-after { border-color: greenyellow; box-shadow: inset 0 -3px 0 0 greenyellow, 0 0 0 1px rgba(173,255,47,0.35); }
    .block-minimap-item.is-cover { border-color: rgba(173,255,47,0.55); }
    .block-minimap-item.is-cover.is-drop-before, .block-minimap-item.is-cover.is-drop-after { border-color: greenyellow; }
    .block-minimap-item.just-moved { animation: moveHighlight 0.6s ease-out; }
    .block-minimap-main { flex: 1; min-height: 0; padding: 8px 8px 8px; display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
    .block-minimap-index { position: absolute; top: 6px; left: 6px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 4px; background: rgba(0,0,0,0.65); color: greenyellow; font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; z-index: 1; }
    .block-minimap-type-row { display: flex; align-items: center; gap: 5px; margin-top: 18px; flex-wrap: wrap; min-height: 16px; }
    .block-minimap-type { font-size: 10px; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .block-minimap-cover { font-size: 9px; padding: 1px 5px; border-radius: 3px; background: greenyellow; color: #000; font-weight: 700; flex-shrink: 0; }
    .block-minimap-preview { flex: 1; font-size: 11px; line-height: 1.35; color: #ccc; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; word-break: break-word; background: #141416; border-radius: 4px; padding: 6px 8px; min-height: 48px; }
    .block-minimap-preview.is-h1 { font-weight: 700; color: #eee; -webkit-line-clamp: 2; }
    .block-minimap-preview.is-quote { font-style: italic; color: #bbb; border-left: 2px solid greenyellow; padding-left: 6px; }
    .block-minimap-preview.is-note { font-family: monospace; font-size: 10px; color: #ff8a8a; }
    .block-minimap-preview.is-empty { color: #666; font-style: italic; }
    .block-minimap-thumb { flex: 1; min-height: 48px; max-height: 72px; border-radius: 4px; overflow: hidden; background: #111; display: flex; align-items: center; justify-content: center; }
    .block-minimap-thumb img, .block-minimap-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
    .block-minimap-del { position: absolute; top: 6px; right: 6px; width: 20px; height: 20px; border-radius: 50%; background: #ff4d4f; color: #fff; border: none; opacity: 0; pointer-events: none; z-index: 2; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px; line-height: 1; font-weight: 700; transition: opacity 0.15s, transform 0.15s; box-shadow: 0 2px 6px rgba(0,0,0,0.35); padding: 0; }
    .block-minimap-item:hover .block-minimap-del { opacity: 1; pointer-events: auto; }
    .block-minimap-del:hover { transform: scale(1.08); background: #ff7875; }
    .acc-btn { width: 100%; background: #424242; padding: 15px 20px; border-radius: 10px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; border: 1px solid #555; color: #fff; margin-bottom: 10px; transition: 0.2s; }
    .acc-btn:hover { border-color: greenyellow; color: greenyellow; }
    .acc-content { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 0.32s ease; padding: 0 10px; }
    .acc-content.open { grid-template-rows: 1fr; padding-bottom: 20px; }
    .acc-content-inner { overflow: hidden; min-height: 0; }
    .acc-content.open .acc-content-inner { overflow: visible; }
    .neo-btn { --bg: #000; --hover-bg: #ff90e8; --hover-text: #000; color: #fff; cursor: pointer; border: 1px solid var(--bg); border-radius: 4px; padding: 0.8em 2em; background: var(--bg); transition: 0.2s; display: flex; justify-content: center; align-items: center; font-weight: bold; gap: 8px; }
    .neo-btn:hover { color: var(--hover-text); transform: translate(-0.25rem, -0.25rem); background: var(--hover-bg); box-shadow: 0.25rem 0.25rem var(--bg); border-color: var(--hover-bg); }
    .neo-btn:active { transform: translate(0); box-shadow: none; }
    .admin-top-action-btn { background: #3a3a3a; color: #d6d6d6; border: 1px solid #4d4d4d; padding: 10px 16px; border-radius: 12px; font-weight: bold; font-size: 13px; cursor: pointer; flex-shrink: 0; transition: transform 0.2s ease, background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease; }
    .admin-top-action-btn:hover { background: #45454a; border-color: #5a5a62; transform: translateY(-1px); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35); }
    .admin-top-action-btn:active { transform: scale(0.96); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25); }
    .group { display: flex; line-height: 28px; align-items: center; position: relative; max-width: 240px; }
    .input { font-family: "Montserrat", sans-serif; width: 100%; height: 45px; padding-left: 2.5rem; box-shadow: 0 0 0 1.5px #2b2c37, 0 0 25px -17px #000; border: 0; border-radius: 12px; background-color: #16171d; outline: none; color: #bdbecb; transition: all 0.25s cubic-bezier(0.19, 1, 0.22, 1); cursor: text; z-index: 0; }
    .input::placeholder { color: #bdbecb; }
    .input:hover { box-shadow: 0 0 0 2.5px #2f303d, 0px 0px 25px -15px #000; }
    .input:active { transform: scale(0.95); }
    .input:focus { box-shadow: 0 0 0 2.5px #2f303d; }
    .search-icon { position: absolute; left: 1rem; fill: #bdbecb; width: 1rem; height: 1rem; pointer-events: none; z-index: 1; }
    .fab-scroll { position: fixed; right: 30px; bottom: 150px; display: flex; flex-direction: column; gap: 10px; z-index: 99; }
    .fab-btn { width: 45px; height: 45px; background: greenyellow; color: #000; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.3); cursor: pointer; transition: 0.2s; }
    .fab-btn:hover { transform: scale(1.1); box-shadow: 0 6px 16px rgba(173, 255, 47, 0.4); }
    .category-picker-dropdown { max-height: 220px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #555 #2a2a2e; }
    .category-picker-dropdown::-webkit-scrollbar { width: 8px; }
    .category-picker-dropdown::-webkit-scrollbar-track { background: #2a2a2e; border-radius: 4px; }
    .category-picker-dropdown::-webkit-scrollbar-thumb { background: #555; border-radius: 4px; }
    .category-picker-dropdown::-webkit-scrollbar-thumb:hover { background: #777; }
    .header-actions-menu-wrap { position: relative; flex-shrink: 0; }
    .header-actions-trigger { display: flex; align-items: center; justify-content: center; gap: 4px; min-width: 40px; min-height: 40px; padding: 10px 12px; border-radius: 8px; background: #424242; border: 1px solid greenyellow; color: greenyellow; cursor: pointer; transition: background 0.15s ease, box-shadow 0.15s ease; }
    .header-actions-trigger:hover:not(:disabled) { background: #4a4a4a; box-shadow: 0 0 12px rgba(173, 255, 47, 0.2); }
    .header-actions-trigger:disabled { opacity: 0.45; cursor: not-allowed; }
    .header-actions-gear-trigger { display: flex; align-items: center; justify-content: center; padding: 6px; border-radius: 8px; background: transparent; border: none; color: inherit; opacity: 0.5; cursor: pointer; transition: opacity 0.15s ease, background 0.15s ease; }
    .header-actions-gear-trigger:hover:not(:disabled) { opacity: 0.9; background: rgba(255, 255, 255, 0.06); }
    .header-actions-gear-trigger:disabled { opacity: 0.3; cursor: not-allowed; }
    .header-actions-menu { position: absolute; right: 0; top: calc(100% + 8px); min-width: 220px; padding: 6px; border-radius: 10px; background: #2a2a2e; border: 1px solid #555; box-shadow: 0 12px 32px rgba(0,0,0,0.5); z-index: 200; }
    .header-actions-menu-item { display: block; width: 100%; padding: 10px 12px; border: none; border-radius: 8px; background: transparent; color: #eee; font-size: 13px; font-weight: 600; text-align: left; cursor: pointer; transition: background 0.15s ease; }
    .header-actions-menu-item:hover:not(:disabled) { background: #3a3a3e; }
    .header-actions-menu-item:disabled { opacity: 0.45; cursor: not-allowed; }
    .header-actions-menu-item__hint { display: block; margin-top: 4px; font-size: 11px; font-weight: 400; line-height: 1.35; color: #888; }
    .admin-list-select-btn { padding: 8px 14px; border-radius: 10px; border: 1px solid #555; background: #2a2a2e; color: #ccc; font-size: 12px; font-weight: bold; cursor: pointer; transition: border-color 0.15s, color 0.15s, background 0.15s; flex-shrink: 0; }
    .admin-list-select-btn:hover:not(:disabled) { border-color: greenyellow; color: greenyellow; }
    .admin-list-select-btn.is-active { border-color: greenyellow; color: greenyellow; background: rgba(173,255,47,0.1); }
    .admin-list-select-btn.is-delete { border-color: #f87171; color: #f87171; background: rgba(248,113,113,0.08); }
    .admin-recycle-btn { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 10px; border: 1px solid #555; background: #2a2a2e; color: #ccc; cursor: pointer; transition: border-color 0.15s, color 0.15s, background 0.15s; flex-shrink: 0; position: relative; }
    .admin-recycle-btn:hover:not(:disabled) { border-color: #f87171; color: #f87171; }
    .admin-recycle-btn.is-active { border-color: #f87171; color: #f87171; background: rgba(248,113,113,0.1); }
    .admin-recycle-badge { position: absolute; top: -5px; right: -5px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: #f87171; color: #111; font-size: 10px; font-weight: 800; line-height: 16px; text-align: center; }
    .admin-card-select-mark { position: absolute; top: 10px; left: 10px; z-index: 5; width: 22px; height: 22px; border-radius: 6px; border: 2px solid rgba(255,255,255,0.85); background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; pointer-events: none; }
    .admin-card-select-mark.is-checked { background: greenyellow; border-color: greenyellow; color: #000; font-size: 14px; font-weight: 800; }
    .card-item.is-selected { outline: 2px solid greenyellow; outline-offset: 2px; box-shadow: 0 0 0 1px rgba(173,255,47,0.35); }
    .cover-modal-backdrop { position: fixed; inset: 0; z-index: 10001; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(0,0,0,0); backdrop-filter: blur(0px); pointer-events: none; transition: background 0.28s ease, backdrop-filter 0.28s ease; }
    .cover-modal-backdrop.is-visible { background: rgba(0,0,0,0.72); backdrop-filter: blur(6px); pointer-events: auto; }
    .cover-modal-backdrop.is-closing { background: rgba(0,0,0,0); backdrop-filter: blur(0px); pointer-events: none; }
    .cover-modal-panel { width: min(420px, 92vw); background: #202024; border: 1px solid #444; border-radius: 18px; padding: 28px 26px 22px; box-shadow: 0 24px 60px rgba(0,0,0,0.55); transform: scale(0.88) translateY(16px); opacity: 0; transition: transform 0.32s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.26s ease; }
    .cover-modal-backdrop.is-visible .cover-modal-panel { transform: scale(1) translateY(0); opacity: 1; }
    .cover-modal-backdrop.is-closing .cover-modal-panel { transform: scale(0.94) translateY(8px); opacity: 0; transition: transform 0.22s ease, opacity 0.2s ease; }
    .cover-modal-icon { width: 48px; height: 48px; border-radius: 14px; background: rgba(173,255,47,0.12); border: 1px solid rgba(173,255,47,0.35); display: flex; align-items: center; justify-content: center; font-size: 22px; margin-bottom: 16px; }
    .cover-modal-title { font-size: 17px; font-weight: 700; color: #fff; margin: 0 0 10px; letter-spacing: 0.2px; }
    .cover-modal-desc { font-size: 13px; line-height: 1.75; color: #aaa; margin: 0 0 22px; }
    .cover-modal-actions { display: flex; gap: 10px; }
    .cover-modal-btn { flex: 1; padding: 13px 16px; border-radius: 11px; font-size: 14px; font-weight: 700; cursor: pointer; border: 1px solid transparent; transition: transform 0.16s cubic-bezier(0.34, 1.3, 0.64, 1), background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease, color 0.2s ease; }
    .cover-modal-btn:active { transform: scale(0.96); }
    .cover-modal-btn-secondary { background: #2a2a2e; border-color: #444; color: #ccc; }
    .cover-modal-btn-secondary:hover { background: #333; border-color: #666; color: #fff; box-shadow: 0 4px 14px rgba(0,0,0,0.25); }
    .cover-modal-btn-primary { background: greenyellow; color: #000; box-shadow: 0 0 0 0 rgba(173,255,47,0); }
    .cover-modal-btn-primary:hover { box-shadow: 0 6px 20px rgba(173,255,47,0.35); transform: translateY(-1px); }
    .cover-modal-btn-primary:active { transform: scale(0.96) translateY(0); box-shadow: 0 2px 8px rgba(173,255,47,0.2); }
    .btn-disabled { opacity: 0.5; cursor: not-allowed; }
    .img-drop { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 160px; border: 2px dashed #555; border-radius: 10px; background: #202024; cursor: pointer; transition: 0.2s; padding: 18px; text-align: center; color: #888; }
    .img-drop:hover { border-color: greenyellow; color: greenyellow; background: #1f261b; }
    .img-drop.err { border-color: #ff4d4f; }
    .img-preview { max-width: 100%; max-height: 360px; border-radius: 8px; object-fit: contain; }
    .img-url { font-size: 11px; color: #666; margin-top: 8px; word-break: break-all; font-family: monospace; }
    .img-uploading { display: flex; flex-direction: column; align-items: center; gap: 12px; color: greenyellow; }
    .img-spin { width: 32px; height: 32px; border: 3px solid #333; border-top-color: greenyellow; border-radius: 50%; animation: imgspin 0.8s linear infinite; }
    @keyframes imgspin { to { transform: rotate(360deg); } }
    .img-err { color: #ff4d4f; font-size: 12px; margin-top: 8px; }
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: #202024; }
    ::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: #555; }
    .admin-toast { position: fixed; top: 24px; left: 50%; transform: translateX(-50%) translateY(-12px); z-index: 10002; padding: 12px 22px; border-radius: 12px; background: #202024; border: 1px solid rgba(173,255,47,0.45); color: #eee; font-size: 14px; font-weight: 600; box-shadow: 0 12px 36px rgba(0,0,0,0.45); opacity: 0; pointer-events: none; transition: opacity 0.26s ease, transform 0.26s ease; white-space: nowrap; }
    .admin-toast.is-visible { opacity: 1; transform: translateX(-50%) translateY(0); }
    .admin-toast.is-closing { opacity: 0; transform: translateX(-50%) translateY(-8px); }
    .admin-shell { box-sizing: border-box; }
    .editor-form-panel { box-sizing: border-box; max-width: 100%; overflow-x: hidden; }
    .editor-step-grid { display: grid; gap: 20px; align-items: start; }
    .editor-step-grid--dual { grid-template-columns: 1fr 1fr; }
    .editor-step-grid--single { grid-template-columns: 1fr; }
    .editor-date-field { min-width: 0; }
    .editor-date-field input[type="date"] { width: 100%; min-width: 0; -webkit-appearance: none; appearance: none; }
    .block-add-toolbar { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 25px; }
    .block-add-toolbar .neo-btn { width: 100%; padding: 0.8em 0.4em; font-size: 13px; white-space: nowrap; box-sizing: border-box; justify-content: center; }
    .category-picker-wrap { position: relative; margin-bottom: 10px; min-width: 0; }
    .category-picker-trigger { display: flex; align-items: stretch; min-width: 0; }
    .category-picker-selected { flex: 1; min-width: 0; box-sizing: border-box; display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #18181c; border: 1px solid #333; border-right: none; border-top-left-radius: 10px; border-bottom-left-radius: 10px; }
    .category-picker-chip { display: inline-flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-width: 0; flex: 1; background: rgba(173,255,47,0.14); border: 1px solid rgba(173,255,47,0.45); color: greenyellow; padding: 5px 10px; border-radius: 6px; font-size: 13px; font-weight: 600; }
    .category-picker-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
    .category-picker-dropdown-btn { width: 44px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: #18181c; border: 1px solid #333; border-left: 1px solid #444; border-top-right-radius: 10px; border-bottom-right-radius: 10px; color: #aaa; cursor: pointer; transition: 0.2s; }
    .category-picker-dropdown-btn.is-open { background: rgba(173,255,47,0.12); color: greenyellow; }
    .editor-cat-create-row { display: flex; gap: 8px; align-items: center; }
    .acc-btn-title { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; flex: 1; min-width: 0; font-weight: bold; }
    .acc-btn-chevron { flex-shrink: 0; display: flex; align-items: center; margin-left: 8px; }
    @media (max-width: 768px) {
      .admin-shell { padding-left: 12px; padding-right: 12px; }
      .editor-form-panel { padding: 16px !important; border-radius: 14px !important; }
      .editor-step-grid--dual { grid-template-columns: 1fr; gap: 16px; }
      .acc-btn { padding: 12px 14px; align-items: flex-start; gap: 8px; }
      .acc-btn-title { font-size: 14px; line-height: 1.4; }
      .acc-content { padding: 0 4px; }
      .acc-content.open { padding-bottom: 16px; }
      .category-picker-selected { flex-wrap: wrap; padding: 8px 10px; gap: 6px; }
      .category-picker-chip { flex: 1 1 100%; }
      .category-edit-btn, .category-perm-del { width: 34px; height: 34px; margin-left: 0; }
      .category-picker-dropdown-btn { width: 40px; min-height: 44px; }
      .editor-cat-create-row { flex-wrap: wrap; }
      .editor-cat-create-row .glow-input { flex: 1 1 100%; min-width: 0; }
      .block-add-toolbar { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 20px; }
      .block-add-toolbar .neo-btn { width: 100%; padding: 0.7em 0.6em; font-size: 13px; }
      .neo-btn:hover { transform: none; box-shadow: none; }
      .fab-scroll { right: 14px; bottom: 100px; gap: 8px; }
      .fab-btn { width: 40px; height: 40px; }
      .gallery-only-tag { font-size: 9px; padding: 1px 5px; }
      .admin-toast { max-width: calc(100vw - 24px); white-space: normal; text-align: center; }
    }
    @media (max-width: 400px) {
      .block-add-toolbar { grid-template-columns: 1fr; }
      .block-add-toolbar .neo-btn { padding: 0.75em 1em; }
    }
  `}} />
);

// --- 3. 辅助组件 ---
const SearchInput = ({ value, onChange }) => (
  <div className="group">
    <svg className="search-icon" aria-hidden="true" viewBox="0 0 24 24"><g><path d="M21.53 20.47l-3.66-3.66C19.195 15.24 20 13.214 20 11c0-4.97-4.03-9-9-9s-9 4.03-9 9 4.03 9 9 9c2.215 0 4.24-.804 5.808-2.13l3.66 3.66c.147.146.34.22.53.22s.385-.073.53-.22c.295-.293.295-.767.002-1.06zM3.5 11c0-4.135 3.365-7.5 7.5-7.5s7.5 3.365 7.5 7.5-3.365 7.5-7.5 7.5-7.5-3.365-7.5-7.5z"></path></g></svg>
    <input placeholder="搜索" type="search" className="input" value={value} onChange={onChange} />
  </div>
);

const GalleryOnlyTag = () => (
  <span className="gallery-only-tag">(Gallery主题专用)</span>
);

// P18-C3: shop 系列主题专用标注（浅粉底 pill；样式参照 GalleryOnlyTag）
const ShopOnlyTag = () => (
  <span className="gallery-only-tag">(shop主题专用)</span>
);

// P18C45FIX B2: Step7 商品查询弹窗客户端判定（与 post.js/merchantProducts.ts 的 isMerchantProductOnSale 词表保持一致）
const SHOP_LOOKUP_OFF_SALE_RE = /off[-_ ]?sale|offsale|off-shelf|下架|停售|discontinued|inactive|unavailable|disabled/i;
const isShopLookupProductOnSale = (product) => {
  const status = String(product?.status || '').trim();
  return status ? !SHOP_LOOKUP_OFF_SALE_RE.test(status) : true;
};
const formatShopLookupPrice = (price) => {
  const trimmed = String(price || '').trim();
  if (!trimmed) return '—';
  return /¥|￥|cny/i.test(trimmed) ? trimmed : `¥${trimmed}`;
};
const lookupErrorText = (error) => {
  const text = String(error || '').trim();
  if (!text) return '未知错误';
  return /abort|timeout|etimedout/i.test(text) ? '查询超时(8s)' : text;
};

const ViewModeButton = ({ label, active, onClick }) => (
  <button
    type="button"
    className={`view-mode-btn ${active ? 'is-active' : ''}`}
    onClick={onClick}
    aria-pressed={active}
  >
    <svg className="view-mode-sparkle" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M14.187 8.096L15 5.25L15.813 8.096C16.0231 8.83114 16.4171 9.50062 16.9577 10.0413C17.4984 10.5819 18.1679 10.9759 18.903 11.186L21.75 12L18.904 12.813C18.1689 13.0231 17.4994 13.4171 16.9587 13.9577C16.4181 14.4984 16.0241 15.1679 15.814 15.903L15 18.75L14.187 15.904C13.9769 15.1689 13.5829 14.4994 13.0423 13.9587C12.5016 13.4181 11.8321 13.0241 11.097 12.814L8.25 12L11.096 11.187C11.8311 10.9769 12.5006 10.5829 13.0413 10.0423C13.5819 9.50162 13.9759 8.83214 14.186 8.097L14.187 8.096Z" />
    </svg>
    <span className="view-mode-text">{label}</span>
  </button>
);

const AdminToast = ({ message, visible, closing }) => {
  if (!visible && !closing) return null;
  return (
    <div
      className={`admin-toast ${visible && !closing ? 'is-visible' : ''} ${closing ? 'is-closing' : ''}`}
      role="status"
      aria-live="polite"
    >
      {message}
    </div>
  );
};

const StepAccordion = ({ step, title, isOpen, onToggle, children }) => (
  <div>
    <div className="acc-btn" onClick={onToggle}>
      <div className="acc-btn-title">
        <span style={{color:'greenyellow'}}>Step {step}</span>
        <span>{title}</span>
      </div>
      <div className="acc-btn-chevron" style={{transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition:'0.3s'}}><Icons.ChevronDown /></div>
    </div>
    <div className={`acc-content ${isOpen ? 'open' : ''}`}>
      <div className="acc-content-inner">{children}</div>
    </div>
  </div>
);

const AnimatedBtn = ({ text, onClick, style }) => (
  <button className="animated-button" onClick={onClick} style={style}>
    <svg viewBox="0 0 24 24" className="arr-2" xmlns="http://www.w3.org/2000/svg"><path d="M16.1716 10.9999L10.8076 5.63589L12.2218 4.22168L20 11.9999L12.2218 19.778L10.8076 18.3638L16.1716 12.9999H4V10.9999H16.1716Z"></path></svg>
    <span className="text">{text}</span>
    <span className="circle"></span>
    <svg viewBox="0 0 24 24" className="arr-1" xmlns="http://www.w3.org/2000/svg"><path d="M16.1716 10.9999L10.8076 5.63589L12.2218 4.22168L20 11.9999L12.2218 19.778L10.8076 18.3638L16.1716 12.9999H4V10.9999H16.1716Z"></path></svg>
  </button>
);

const SlidingNav = ({ activeIdx, onSelect }) => {
  const icons = [Icons.FolderMode, Icons.CoverMode, Icons.TextMode, Icons.GridMode];
  return (
    <div className="nav-container">
      <div className="nav-glider" style={{ left: `${activeIdx * 45 + 5}px`, width: '40px' }} />
      {icons.map((Icon, i) => (<div key={i} className={`nav-item ${activeIdx === i ? 'active' : ''}`} onClick={() => onSelect(i)}><Icon /></div>))}
    </div>
  );
};

function toDateKey(dateStr) {
  if (!dateStr) return '';
  const s = String(dateStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const CAL_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const AdminPublishCalendar = ({ month, publishedDates, selectedDate, onMonthChange, onSelectDate }) => {
  const year = month.getFullYear();
  const mon = month.getMonth();
  const firstDow = new Date(year, mon, 1).getDay();
  const daysInMonth = new Date(year, mon + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const monthLabel = `${year}年${mon + 1}月`;

  return (
    <div
      className="admin-date-calendar"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: 'calc(100% + 10px)',
        right: 0,
        width: '280px',
        background: '#2a2a2e',
        border: '1px solid #555',
        borderRadius: '14px',
        padding: '14px',
        zIndex: 60,
        boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <button
          type="button"
          onClick={() => onMonthChange(new Date(year, mon - 1, 1))}
          style={{ background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: '18px', padding: '4px 8px' }}
        >
          ‹
        </button>
        <span style={{ fontSize: '14px', fontWeight: 'bold', color: '#fff' }}>{monthLabel}</span>
        <button
          type="button"
          onClick={() => onMonthChange(new Date(year, mon + 1, 1))}
          style={{ background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: '18px', padding: '4px 8px' }}
        >
          ›
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', marginBottom: '6px' }}>
        {CAL_WEEKDAYS.map((w) => (
          <div key={w} style={{ textAlign: 'center', fontSize: '11px', color: '#777', padding: '4px 0' }}>{w}</div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px' }}>
        {cells.map((day, idx) => {
          if (day == null) return <div key={`e-${idx}`} />;
          const key = `${year}-${String(mon + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const hasPosts = publishedDates.has(key);
          const isSelected = selectedDate === key;
          const clickable = hasPosts;
          return (
            <button
              key={key}
              type="button"
              disabled={!clickable}
              onClick={() => clickable && onSelectDate(key)}
              style={{
                aspectRatio: '1',
                border: 'none',
                borderRadius: '8px',
                fontSize: '13px',
                fontWeight: isSelected ? 'bold' : 'normal',
                cursor: clickable ? 'pointer' : 'default',
                background: isSelected ? 'greenyellow' : clickable ? 'rgba(173,255,47,0.12)' : 'transparent',
                color: isSelected ? '#000' : clickable ? '#eee' : '#555',
                opacity: clickable ? 1 : 0.45,
              }}
            >
              {day}
            </button>
          );
        })}
      </div>
      {selectedDate ? (
        <button
          type="button"
          onClick={() => onSelectDate(null)}
          style={{
            marginTop: '12px',
            width: '100%',
            padding: '8px',
            borderRadius: '8px',
            border: '1px solid #555',
            background: 'transparent',
            color: '#aaa',
            fontSize: '12px',
            cursor: 'pointer',
          }}
        >
          清除日期筛选
        </button>
      ) : (
        <p style={{ margin: '10px 0 0', fontSize: '11px', color: '#666', textAlign: 'center', lineHeight: 1.5 }}>
          高亮日期为已发布文章，点击筛选
        </p>
      )}
    </div>
  );
};

/** 分类搜索 + 可滚动下拉列表（fixed 定位，避免被 accordion overflow 裁剪） */
const CategoryPicker = ({
  value,
  categories,
  onChange,
  onRequestDelete,
  onRenameCategory,
}) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [menuRect, setMenuRect] = useState(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const inputRef = useRef(null);
  const renameInputRef = useRef(null);

  const hasSelection = !!(value && value.trim());

  useEffect(() => {
    if (!hasSelection) return;
    setQuery('');
  }, [hasSelection]);

  useEffect(() => {
    setIsRenaming(false);
    setRenameDraft('');
  }, [value]);

  const updateMenuRect = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setMenuRect({
      top: rect.bottom + 6,
      left: rect.left,
      width: rect.width,
    });
  }, []);

  useEffect(() => {
    if (!open) {
      setMenuRect(null);
      return;
    }
    updateMenuRect();
    const onReposition = () => updateMenuRect();
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
    return () => {
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
    };
  }, [open, updateMenuRect]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  const allCategories = useMemo(() => {
    const list = [...(categories || [])].filter((c) => !isProtectedCategory(c));
    if (!list.includes(FALLBACK_CATEGORY)) list.push(FALLBACK_CATEGORY);
    if (value && !list.includes(value) && !isProtectedCategory(value)) list.unshift(value);
    return list.sort((a, b) => {
      if (a === FALLBACK_CATEGORY) return -1;
      if (b === FALLBACK_CATEGORY) return 1;
      return a.localeCompare(b, 'zh-CN');
    });
  }, [categories, value]);

  const filteredCategories = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allCategories;
    return allCategories.filter((c) => c.toLowerCase().includes(q));
  }, [allCategories, query]);

  const listCategories = showAll ? allCategories : filteredCategories;

  const findExistingCategory = (text) => {
    const trimmed = (text || '').trim();
    if (!trimmed || isProtectedCategory(trimmed)) return null;
    if (allCategories.includes(trimmed)) return trimmed;
    const lower = trimmed.toLowerCase();
    return allCategories.find((c) => c.toLowerCase() === lower) || null;
  };

  const commitCategory = (text) => {
    const trimmed = (text || '').trim();
    if (!trimmed || isProtectedCategory(trimmed)) return;
    pickCategory(findExistingCategory(trimmed) || trimmed);
  };

  const pickCategory = (cat) => {
    if (isProtectedCategory(cat)) return;
    onChange(cat);
    setQuery('');
    setOpen(false);
    setShowAll(false);
    setIsRenaming(false);
  };

  const clearSelection = (e) => {
    if (e) e.stopPropagation();
    onChange('');
    setQuery('');
    setOpen(false);
    setShowAll(false);
    setIsRenaming(false);
  };

  const startRename = (e) => {
    e.stopPropagation();
    setIsRenaming(true);
    setRenameDraft(value);
    setOpen(false);
    requestAnimationFrame(() => renameInputRef.current?.focus());
  };

  const saveRename = (e) => {
    if (e) e.stopPropagation();
    const next = (renameDraft || '').trim();
    if (!next || isSystemReservedCategory(next)) return;
    if (typeof onRenameCategory === 'function') {
      onRenameCategory(value, next);
    }
    setIsRenaming(false);
  };

  const toggleDropdown = () => {
    setOpen((prev) => {
      if (!prev) setShowAll(true);
      return !prev;
    });
  };

  const canManageCategory =
    hasSelection &&
    (categories || []).includes(value) &&
    !isSystemReservedCategory(value);

  const canPermanentlyDelete =
    canManageCategory && typeof onRequestDelete === 'function';

  const canRename =
    canManageCategory && typeof onRenameCategory === 'function';

  return (
    <div ref={wrapRef} className="category-picker-wrap">
      <div ref={triggerRef} className="category-picker-trigger">
        {hasSelection ? (
          <div
            className="category-picker-selected"
            onClick={() => { if (!isRenaming) { setOpen(true); setShowAll(true); } }}
            title={isRenaming ? '编辑分类名称' : '点击浏览全部分类，或点 × 清除'}
            style={{
              minHeight: '50px',
              cursor: isRenaming ? 'default' : 'pointer',
            }}
          >
            <span className="category-picker-chip">
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  className="glow-input"
                  value={renameDraft}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      saveRename(e);
                    } else if (e.key === 'Escape') {
                      e.stopPropagation();
                      setIsRenaming(false);
                      setRenameDraft(value);
                    }
                  }}
                  style={{
                    flex: 1,
                    marginBottom: 0,
                    padding: '4px 8px',
                    fontSize: '13px',
                    minWidth: 0,
                  }}
                />
              ) : (
                <span className="category-picker-chip-label">
                  {value}
                </span>
              )}
              {!isRenaming ? (
                <span
                  role="button"
                  tabIndex={0}
                  onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  onClick={(e) => { e.stopPropagation(); clearSelection(e); }}
                  title="清除分类"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '16px',
                    height: '16px',
                    borderRadius: '50%',
                    background: 'rgba(173,255,47,0.25)',
                    color: '#eaffd0',
                    fontSize: '12px',
                    lineHeight: 1,
                    cursor: 'pointer',
                    flexShrink: 0,
                    marginLeft: 'auto',
                  }}
                >
                  ×
                </span>
              ) : null}
            </span>
            {canRename ? (
              isRenaming ? (
                <button
                  type="button"
                  className="category-edit-btn"
                  onClick={saveRename}
                  title="保存分类名称"
                >
                  保存
                </button>
              ) : (
                <button
                  type="button"
                  className="category-edit-btn"
                  onClick={startRename}
                  title="编辑分类名称"
                  aria-label={`编辑分类 ${value}`}
                >
                  <Icons.Edit />
                </button>
              )
            ) : null}
            {canPermanentlyDelete ? (
              <button
                type="button"
                className="category-perm-del"
                onClick={(e) => {
                  e.stopPropagation();
                  onRequestDelete(value);
                }}
                title={`永久删除此分类（相关文章将归入「${FALLBACK_CATEGORY}」）`}
                aria-label={`永久删除分类 ${value}`}
              >
                <Icons.Trash />
              </button>
            ) : null}
          </div>
        ) : (
          <input
            ref={inputRef}
            className="glow-input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShowAll(false);
              setOpen(true);
              const trimmed = e.target.value.trim();
              if (!trimmed) onChange('');
              else {
                const existing = findExistingCategory(trimmed);
                if (existing) onChange(existing);
              }
            }}
            onFocus={() => { setOpen(true); setShowAll(false); }}
            onBlur={() => {
              const trimmed = query.trim();
              if (!trimmed) return;
              const existing = findExistingCategory(trimmed);
              if (existing) {
                if (existing !== value) pickCategory(existing);
                return;
              }
              if (filteredCategories.length === 0) commitCategory(trimmed);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const trimmed = query.trim();
                if (!trimmed) return;
                const existing = findExistingCategory(trimmed);
                if (existing) pickCategory(existing);
                else if (listCategories.length === 1) pickCategory(listCategories[0]);
                else commitCategory(trimmed);
              } else if (e.key === 'Escape') {
                setOpen(false);
                setShowAll(false);
                setQuery('');
              }
            }}
            placeholder="搜索或输入新分类，回车确认"
            style={{
              flex: 1,
              marginBottom: 0,
              borderTopRightRadius: 0,
              borderBottomRightRadius: 0,
              borderRight: 'none',
            }}
          />
        )}
        <button
          type="button"
          className={`category-picker-dropdown-btn${open ? ' is-open' : ''}`}
          onClick={toggleDropdown}
          title={open ? '收起分类列表' : '展开全部分类'}
        >
          <span style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', display: 'flex' }}>
            <Icons.ChevronDown />
          </span>
        </button>
      </div>

      {open && menuRect ? (
        <div
          className="category-picker-dropdown"
          style={{
            position: 'fixed',
            top: menuRect.top,
            left: menuRect.left,
            width: menuRect.width,
            zIndex: 1200,
            background: '#2a2a2e',
            border: '1px solid #555',
            borderRadius: '10px',
            boxShadow: '0 12px 28px rgba(0,0,0,0.55)',
          }}
        >
          {listCategories.length > 0 ? (
            listCategories.map((cat) => {
              const active = cat === value;
              const reserved = isSystemReservedCategory(cat);
              const showRowDelete =
                typeof onRequestDelete === 'function' && !reserved;
              return (
                <div key={cat} className="category-dropdown-row">
                  <button
                    type="button"
                    className="category-dropdown-pick"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickCategory(cat)}
                    style={{
                      background: active ? 'rgba(173,255,47,0.12)' : 'transparent',
                      color: active ? 'greenyellow' : '#eee',
                      cursor: 'pointer',
                      opacity: 1,
                    }}
                    onMouseEnter={(e) => {
                      if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                    }}
                    onMouseLeave={(e) => {
                      if (!active) e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    {cat}
                  </button>
                  {showRowDelete ? (
                    <button
                      type="button"
                      className="category-dropdown-del"
                      title={`永久删除分类「${cat}」`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(false);
                        onRequestDelete(cat);
                      }}
                    >
                      <Icons.Trash />
                    </button>
                  ) : null}
                </div>
              );
            })
          ) : query.trim() ? (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commitCategory(query)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '10px 14px',
                border: 'none',
                background: 'rgba(173,255,47,0.08)',
                color: 'greenyellow',
                fontSize: '13px',
                cursor: 'pointer',
              }}
            >
              创建分类「{query.trim()}」
            </button>
          ) : (
            <div style={{ padding: '14px', fontSize: '12px', color: '#888', textAlign: 'center' }}>
              无匹配分类
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
};

const SAVE_PHASE_META = {
  media: {
    title: '正在上传图片块',
    hint: '图片处理上传中，请稍候',
  },
  post: {
    title: '正在保存文章',
    hint: '正在保存文章与正文内容…',
  },
  gallery: {
    title: '正在上传图库',
    hint: '批量处理中，请稍候',
  },
  delete: {
    title: '正在彻底删除',
    hint: '请勿关闭页面',
  },
  archive: {
    title: '正在移入回收站',
    hint: '请勿关闭页面',
  },
  restore: {
    title: '正在恢复文章',
    hint: '请勿关闭页面',
  },
  siteTitle: {
    title: '正在更改网站名称',
    hint: '请勿关闭页面',
  },
};

function getGalleryLoaderHint(phase, progress) {
  if (progress?.hint) return progress.hint;
  if (phase !== 'gallery') return SAVE_PHASE_META[phase]?.hint || '';
  if (progress?.total > 0) return SAVE_PHASE_META.gallery.hint;
  return '正在同步图库内容…';
}

const FullScreenLoader = ({ phase, progress }) => {
  const isTheme = phase === 'theme';
  const meta = SAVE_PHASE_META[phase];
  const hasProgress = progress && progress.total > 0;
  const title = isTheme
    ? (hasProgress && progress?.step === 2
        ? ''
        : (progress?.label || '正在切换主题…'))
    : phase === 'gallery' && !(progress?.total > 0)
      ? '正在同步图库'
      : meta?.title || '加载中…';
  const hint = isTheme
    ? (hasProgress && progress?.step === 2 ? '' : (progress?.hint || ''))
    : getGalleryLoaderHint(phase, progress);
  const pct = hasProgress
    ? Math.min(100, Math.round((progress.done / progress.total) * 100))
    : 0;
  const progressUnit = ['delete', 'archive', 'restore'].includes(phase) ? '步' : '页';
  const stepLine = isTheme && progress?.totalSteps
    ? `步骤 ${progress.step} / ${progress.totalSteps}`
    : null;

  return (
    <div className="loader-overlay" role="alertdialog" aria-modal="true" aria-busy="true">
      <div className="loader">
        <svg viewBox="0 0 200 60" width="200" height="60">
          <path className="dash" fill="none" stroke="greenyellow" strokeWidth="3" d="M20,50 L20,10 L50,10 C65,10 65,30 50,30 L20,30" />
          <path className="dash" fill="none" stroke="greenyellow" strokeWidth="3" d="M80,50 L80,10 L110,10 C125,10 125,30 110,30 L80,30 M100,30 L120,50" />
          <path className="dash" fill="none" stroke="greenyellow" strokeWidth="3" d="M140,30 A20,20 0 1,0 180,30 A20,20 0 1,0 140,30" />
        </svg>
      </div>
      <div className="loader-text">处理中</div>
      {stepLine ? <div className="loader-step">{stepLine}</div> : null}
      {title ? <div className="loader-phase">{title}</div> : null}
      {hasProgress ? (
        <div className="loader-detail">
          {progress.hint ? (
            <>
              {progress.hint}
              <span style={{ opacity: 0.75 }}>
                {' '}
                · {progress.done}/{progress.total}（{pct}%）
              </span>
            </>
          ) : (
            <>已完成 {progress.done} / {progress.total} {progressUnit}（{pct}%）</>
          )}
        </div>
      ) : (
        <div className="loader-detail">
          {isTheme || phase === 'post' || phase === 'delete' || phase === 'archive' || phase === 'restore'
            ? '请稍候…'
            : ''}
        </div>
      )}
      {hasProgress || isTheme ? (
        <div className="loader-progress-track">
          <div
            className="loader-progress-bar"
            style={{ width: `${hasProgress ? pct : (isTheme && progress?.step ? Math.round((progress.step / progress.totalSteps) * 100) : 0)}%` }}
          />
        </div>
      ) : null}
      {hint ? <div className="loader-hint">{hint}</div> : null}
      {isTheme ? (
        <div className="loader-lock-hint">主题切换期间请勿操作后台，以免数据冲突</div>
      ) : null}
    </div>
  );
};

/** 发布队列：各阶段文案；失败阶段名（Phase4 保留 phase 后展示） */
const PUBLISH_QUEUE_PHASE_LABELS = {
  media: '正文图片上传',
  gallery: '图库上传/同步',
  post: '写入文章',
  refresh: '前台刷新',
};

function pubqStateText(job) {
  const elapsed = formatJobElapsed(job.startedAt);
  const elapsedSuffix = elapsed ? ` · 已运行 ${elapsed}` : '';

  if (job.status === 'queued') return '队列中';
  if (job.status === 'success') return '已完成';
  if (job.status === 'error') {
    const failedLabel = PUBLISH_QUEUE_PHASE_LABELS[job.phase];
    return failedLabel ? `发布失败（${failedLabel}）` : '发布失败';
  }
  if (job.stalled) {
    return `长时间无进度更新${elapsed ? `（已运行 ${elapsed}）` : ''}`;
  }
  // running
  if (job.phase === 'media') {
    const base = job.progress
      ? `上传正文内容 ${job.progress.done}/${job.progress.total}`
      : '准备上传图片…';
    return base + elapsedSuffix;
  }
  if (job.phase === 'gallery') {
    const base = job.progress?.total
      ? `上传图库 ${job.progress.done}/${job.progress.total}`
      : '同步图库…';
    return base + elapsedSuffix;
  }
  if (job.phase === 'refresh') return '正在更新前台页面…' + elapsedSuffix;
  if (job.phase === 'post') return '正在写入文章…' + elapsedSuffix;
  return '处理中…' + elapsedSuffix;
}

/** 发布队列面板：固定在右上角，后台逐条处理，不阻塞编辑 */
const PublishQueuePanel = ({
  jobs,
  onRetry,
  onRetryFromPhase,
  onRestoreToEditor,
  onRemove,
  onForceComplete,
}) => {
  const [, setElapsedTick] = useState(0);

  useEffect(() => {
    const hasRunning = jobs.some((j) => j.status === 'running');
    if (!hasRunning) return;
    const timer = setInterval(() => setElapsedTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [jobs]);
  if (!jobs || jobs.length === 0) return null;
  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;

  return (
    <div className="pubq">
      <div className="pubq-head">
        <span>发布队列{active > 0 ? ` · 进行中 ${active}` : ''}</span>
        <b>{jobs.length}</b>
      </div>
      <div className="pubq-list">
        {jobs.map((job) => {
          const determinate = job.progress && job.progress.total > 0;
          const pct = determinate
            ? Math.min(100, Math.round((job.progress.done / job.progress.total) * 100))
            : 0;
          const stateColor =
            job.status === 'error' ? '#ff6b6d'
            : job.status === 'success' ? 'greenyellow'
            : job.status === 'queued' ? '#999'
            : job.stalled ? '#fbbf24'
            : 'greenyellow';
          return (
            <div
              key={job.id}
              className={`pubq-card${job.status === 'error' ? ' is-err' : job.status === 'success' ? ' is-ok' : job.stalled ? ' is-err' : ''}`}
            >
              <div className="pubq-row">
                {job.status === 'running' && !job.stalled && <span className="pubq-spin" />}
                {job.status === 'running' && job.stalled && <span className="pubq-warn" aria-hidden>!</span>}
                <span className="pubq-title" title={job.title}>{job.title}</span>
                <div className="pubq-actions">
                  {job.status === 'error' && (
                    <button className="pubq-retry" onClick={() => onRetry(job.id)}>重试</button>
                  )}
                  {job.status === 'error' && !job.payload?.isWidget && onRetryFromPhase && (
                    <button className="pubq-retry" onClick={() => onRetryFromPhase(job.id)}>仅重试失败步骤</button>
                  )}
                  {job.status === 'error' && !job.payload?.isWidget && onRestoreToEditor && (
                    <button className="pubq-retry" onClick={() => onRestoreToEditor(job.id)}>恢复到编辑器</button>
                  )}
                  {job.status === 'running' && job.stalled && onForceComplete && (
                    <button className="pubq-retry" onClick={() => onForceComplete(job.id)}>标记完成</button>
                  )}
                  <button
                    className="pubq-x"
                    title={job.status === 'queued' || job.status === 'running' ? '取消发布' : '移除'}
                    onClick={() => onRemove(job)}
                  >
                    ×
                  </button>
                </div>
              </div>
              <div className="pubq-state" style={{ color: stateColor }}>{pubqStateText(job)}</div>
              {job.status === 'running' && job.stalled && (
                <div className="pubq-stall-hint">
                  已连续较长时间未收到进度更新。若内容列表已有该条目，可点「标记完成」继续后续队列。
                </div>
              )}
              {job.status === 'running' && (
                <div className="pubq-bar-track">
                  {determinate ? (
                    <div className="pubq-bar" style={{ width: `${pct}%` }} />
                  ) : (
                    <div className="pubq-bar-indet" />
                  )}
                </div>
              )}
              {job.status === 'success' && (
                <div className="pubq-bar-track">
                  <div className="pubq-bar" style={{ width: '100%' }} />
                </div>
              )}
              {job.status === 'error' && job.error && (
                <div className="pubq-detail is-err">{job.error}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/** 分类/标签永久删除确认弹窗 */
const TaxonomyConfirmModal = ({ open, closing, categoryName, onConfirm, onCancel }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open && !closing) {
      setVisible(false);
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
      return () => cancelAnimationFrame(id);
    }
    if (!open || closing) setVisible(false);
  }, [open, closing]);

  if (!open && !closing) return null;

  return (
    <div
      className={`cover-modal-backdrop ${visible && !closing ? 'is-visible' : ''} ${closing ? 'is-closing' : ''}`}
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="cover-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="taxonomy-confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cover-modal-icon" aria-hidden>🗂️</div>
        <h3 id="taxonomy-confirm-title" className="cover-modal-title">永久删除分类？</h3>
        <p className="cover-modal-desc">
          确定要永久删除分类<strong style={{ color: '#ddd' }}>「{categoryName}」</strong>吗？
          原使用该分类的文章将自动归入<strong style={{ color: '#ddd' }}>「{FALLBACK_CATEGORY}」</strong>分类，且无法撤销。
          <br /><br />
          如需重新为这些文章指定分类，请前往列表视图的<strong style={{ color: '#ddd' }}>分类文件夹</strong>，打开<strong style={{ color: '#ddd' }}>「{FALLBACK_CATEGORY}」</strong>文件夹查看并编辑。
        </p>
        <div className="cover-modal-actions">
          <button type="button" className="cover-modal-btn cover-modal-btn-secondary" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="cover-modal-btn cover-modal-btn-primary" onClick={onConfirm} style={{ background: '#ff7875', color: '#fff' }}>
            确认删除
          </button>
        </div>
      </div>
    </div>
  );
};

/** 无图片块时的封面确认弹窗（替代浏览器 confirm） */
const CoverMissingModal = ({ open, closing, onConfirm, onCancel }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open && !closing) {
      setVisible(false);
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
      return () => cancelAnimationFrame(id);
    }
    if (!open || closing) setVisible(false);
  }, [open, closing]);

  if (!open && !closing) return null;

  return (
    <div
      className={`cover-modal-backdrop ${visible && !closing ? 'is-visible' : ''} ${closing ? 'is-closing' : ''}`}
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="cover-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cover-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cover-modal-icon" aria-hidden>🖼️</div>
        <h3 id="cover-modal-title" className="cover-modal-title">尚未添加图片块</h3>
        <p className="cover-modal-desc">
          当前文章没有任何图片块，发布后将使用<strong style={{ color: '#ddd' }}>默认封面</strong>。
          你可以继续发布，或返回编辑添加图片块。
        </p>
        <div className="cover-modal-actions">
          <button type="button" className="cover-modal-btn cover-modal-btn-secondary" onClick={onCancel}>
            继续编辑
          </button>
          <button type="button" className="cover-modal-btn cover-modal-btn-primary" onClick={onConfirm}>
            确认发布
          </button>
        </div>
      </div>
    </div>
  );
};

/** 发布/保存前的确认弹窗（避免误点底部发布按钮） */
const PUBLISH_MODE_OPTIONS = [
  { value: 'Published', label: '🚀 发布（Published）' },
  { value: 'Draft', label: '📝 存为草稿（Draft）' },
];

const PublishConfirmModal = ({ open, closing, isUpdate, onConfirm, onCancel, publishAs, onPublishAsChange, showModeOptions = true }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open && !closing) {
      setVisible(false);
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
      return () => cancelAnimationFrame(id);
    }
    if (!open || closing) setVisible(false);
  }, [open, closing]);

  if (!open && !closing) return null;

  const title = isUpdate ? '确认保存修改？' : '确认发布？';
  const confirmLabel = publishAs === 'Draft' ? '存为草稿' : (isUpdate ? '确认保存' : '确认发布');
  const desc = isUpdate
    ? '请确认内容已编辑完成，确认无误后再继续。'
    : '请确认内容已编辑完成，确认无误后再继续。';

  return (
    <div
      className={`cover-modal-backdrop ${visible && !closing ? 'is-visible' : ''} ${closing ? 'is-closing' : ''}`}
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="cover-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-confirm-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cover-modal-icon" aria-hidden>📤</div>
        <h3 id="publish-confirm-modal-title" className="cover-modal-title">{title}</h3>
        <p className="cover-modal-desc">{desc}</p>
        {showModeOptions ? (
        <div style={{ display: 'flex', gap: '8px', margin: '0 0 8px' }}>
          {PUBLISH_MODE_OPTIONS.map((opt) => {
            const active = publishAs === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onPublishAsChange?.(opt.value)}
                style={{
                  flex: 1,
                  padding: '10px 8px',
                  borderRadius: '10px',
                  border: active ? '1px solid greenyellow' : '1px solid #3a3a42',
                  background: active ? 'rgba(173,255,47,0.14)' : '#202024',
                  color: active ? 'greenyellow' : '#999',
                  fontSize: '12.5px',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  transition: '0.2s',
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        ) : null}
        {showModeOptions ? (
        <p style={{ fontSize: '11px', color: '#777', margin: '0 0 18px', lineHeight: 1.6 }}>
          存为草稿后内容不会出现在前台，可在内容列表中继续编辑后再发布。
        </p>
        ) : (
        <p style={{ fontSize: '11px', color: '#777', margin: '0 0 18px', lineHeight: 1.6 }}>
          组件保存后立即生效。
        </p>
        )}
        <div className="cover-modal-actions">
          <button type="button" className="cover-modal-btn cover-modal-btn-secondary" onClick={onCancel}>
            继续编辑
          </button>
          <button type="button" className="cover-modal-btn cover-modal-btn-primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

/** 未保存修改离开拦截：三选一弹窗（继续离开 / 留在编辑器 / 保存到草稿） */
const LeaveConfirmModal = ({ open, onLeave, onStay, onSaveDraft, canSaveDraft = true }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setVisible(false);
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
      return () => cancelAnimationFrame(id);
    }
    setVisible(false);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className={`cover-modal-backdrop ${visible ? 'is-visible' : ''}`}
      onClick={onStay}
      role="presentation"
    >
      <div
        className="cover-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-confirm-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cover-modal-icon" aria-hidden>⚠️</div>
        <h3 id="leave-confirm-modal-title" className="cover-modal-title">有未保存的修改</h3>
        <p className="cover-modal-desc">
          当前编辑内容尚未保存，直接离开将丢失这些修改。你可以保存为本地草稿后再离开，稍后回来继续编辑。
        </p>
        <div className="cover-modal-actions" style={{ flexWrap: 'wrap' }}>
          <button type="button" className="cover-modal-btn cover-modal-btn-secondary" onClick={onLeave}>
            继续离开
          </button>
          <button type="button" className="cover-modal-btn cover-modal-btn-secondary" onClick={onStay}>
            留在编辑器
          </button>
          {canSaveDraft ? (
            <button
              type="button"
              className="cover-modal-btn cover-modal-btn-primary"
              onClick={onSaveDraft}
              style={{ flexBasis: '100%' }}
            >
              💾 保存到草稿并离开
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
};

/** 草稿箱卡片时间格式化 */
function formatDraftSnapshotTime(iso) {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '时间未知';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 爬虫入库队列弹窗 */
const CRAWLER_INGEST_STATUS_META = {
  pending: { label: '待入库', color: '#7ee8fc' },
  processing: { label: '处理中', color: '#fbbf24' },
  done: { label: '已完成', color: '#4ade80' },
  failed: { label: '失败', color: '#f87171' },
  skipped: { label: '跳过', color: '#a3a3a3' },
};

const CrawlerIngestPanel = ({
  configured,
  summary,
  tab,
  onTabChange,
  pendingItems,
  processingItems,
  failedItems,
  logItems,
  selectedIds,
  onToggleRow,
  onSelectAllPending,
  onSelectAllFailed,
  onSelectAllProcessing,
  onClearSelection,
  busy,
  progress,
  autoSettings,
  onSaveAutoSettings,
  onIngestSelected,
  onIngestAll,
  onDeleteSelected,
  onRetrySelected,
  onReclaimStale,
  onResetProcessingSelected,
  onCancel,
  onRetry,
  onRefresh,
  onBack,
}) => {
  const pendingCount = summary?.pending ?? 0;
  const processingCount = summary?.processing ?? 0;
  const failedCount = summary?.failed ?? 0;
  const selectedCount = selectedIds.length;
  const selectableTab = tab === 'pending' || tab === 'failed';
  const sessionDone =
    progress ? (progress.sessionSucceeded ?? 0) + (progress.sessionFailed ?? 0) : 0;
  const listRows =
    tab === 'pending'
      ? pendingItems
      : tab === 'processing'
        ? processingItems
        : tab === 'failed'
          ? failedItems
          : logItems;

  const progressPct =
    progress && progress.initialPending > 0
      ? Math.min(100, Math.round((sessionDone / progress.initialPending) * 100))
      : 0;

  const [autoEnabled, setAutoEnabled] = useState(Boolean(autoSettings?.enabled));
  const [autoHour, setAutoHour] = useState(
    typeof autoSettings?.hour === 'number' ? autoSettings.hour : 3
  );
  const [autoSaving, setAutoSaving] = useState(false);

  useEffect(() => {
    setAutoEnabled(Boolean(autoSettings?.enabled));
    setAutoHour(typeof autoSettings?.hour === 'number' ? autoSettings.hour : 3);
  }, [autoSettings?.enabled, autoSettings?.hour]);

  const formatQueueTime = (value) => {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value).slice(0, 19);
    return d.toLocaleString('zh-CN', { hour12: false });
  };

  const renderRow = (row, { selectable = false, showRetry = false }) => {
    const meta = CRAWLER_INGEST_STATUS_META[row.status] || CRAWLER_INGEST_STATUS_META.pending;
    const checked = selectedIds.includes(row.id);
    return (
      <tr key={row.id} style={{ borderTop: '1px solid #3a3a3f' }}>
        {selectable ? (
          <td style={{ padding: '8px 10px', width: '36px' }}>
            <input
              type="checkbox"
              checked={checked}
              disabled={busy}
              onChange={() => onToggleRow(row.id)}
              aria-label={`选择 ${row.title || row.slug}`}
            />
          </td>
        ) : null}
        <td style={{ padding: '8px 10px', color: meta.color, fontWeight: 600 }}>
          {meta.label}
        </td>
        <td style={{ padding: '8px 10px', color: '#eee', maxWidth: '220px' }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.title || '—'}
          </div>
          {row.error_message ? (
            <div style={{ color: '#f87171', fontSize: '11px', marginTop: '4px', lineHeight: 1.4 }}>
              {row.error_message}
            </div>
          ) : null}
        </td>
        <td style={{ padding: '8px 10px', color: '#bbb' }}>{row.slug}</td>
        <td style={{ padding: '8px 10px', color: '#bbb' }}>
          {(row.image_urls && row.image_urls.length) || 0}
        </td>
        <td style={{ padding: '8px 10px', color: '#888', whiteSpace: 'nowrap' }}>
          {formatQueueTime(row.updated_at)}
        </td>
        <td style={{ padding: '8px 10px' }}>
          {showRetry && (row.status === 'failed' || row.status === 'done') ? (
            <button
              type="button"
              onClick={() => onRetry(row.id)}
              disabled={busy}
              style={{
                background: 'none',
                border: row.status === 'failed' ? '1px solid #f87171' : '1px solid #3db8d9',
                color: row.status === 'failed' ? '#f87171' : '#7ee8fc',
                borderRadius: '6px',
                padding: '4px 8px',
                cursor: busy ? 'not-allowed' : 'pointer',
                fontSize: '11px',
              }}
            >
              {row.status === 'failed' ? '重试' : '重新入库'}
            </button>
          ) : (
            <span style={{ color: '#666' }}>—</span>
          )}
        </td>
      </tr>
    );
  };

  const handleSaveAuto = async () => {
    if (!onSaveAutoSettings || autoSaving) return;
    setAutoSaving(true);
    try {
      await onSaveAutoSettings({ enabled: autoEnabled, hour: autoHour });
    } finally {
      setAutoSaving(false);
    }
  };

  const tabs = [
    { id: 'pending', label: `待入库（${pendingCount}）` },
    { id: 'processing', label: `处理中（${processingCount}）` },
    { id: 'failed', label: `入库失败（${failedCount}）` },
    { id: 'log', label: '入库记录' },
  ];

  return (
    <div style={{ background: '#424242', padding: 28, borderRadius: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12 }}>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#fff' }}>📥 爬虫入库管理</div>
          <div style={{ fontSize: '12px', color: '#888', marginTop: 6, lineHeight: 1.5 }}>
            {configured
              ? `待入库 ${pendingCount} · 处理中 ${processingCount} · 已完成 ${summary?.done ?? 0} · 失败 ${failedCount}`
              : '入库服务尚未配置'}
            {configured && pendingCount + processingCount < (pendingItems?.length || 0) + processingCount ? null : null}
          </div>
            {configured && processingCount > 0 ? (
            <div style={{ fontSize: '11px', color: '#fbbf24', marginTop: 4 }}>
              若「处理中」长时间不变，超过 5 分钟会自动标记为失败；也可在「处理中」页手动重置
            </div>
          ) : null}
          {configured && processingCount > 0 && pendingCount > 0 ? (
            <div style={{ fontSize: '11px', color: '#888', marginTop: 4 }}>
              待入库 {pendingCount} 条 + 处理中 {processingCount} 条 = {pendingCount + processingCount} 条尚未完结
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onBack}
          style={{
            padding: '10px 16px',
            borderRadius: '10px',
            border: '1px solid #555',
            background: '#2a2a2e',
            color: '#ccc',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 'bold',
          }}
        >
          返回列表
        </button>
      </div>

      {configured ? (
        <div
          style={{
            marginBottom: 16,
            padding: '12px 14px',
            background: '#2a2a2e',
            borderRadius: '10px',
            border: '1px solid #444',
          }}
        >
          <div style={{ fontSize: '12px', fontWeight: 700, color: '#ccc', marginBottom: 8 }}>
            自动入库（北京时间）
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <label
              style={{
                display: 'inline-flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                color: '#aaa',
                whiteSpace: 'nowrap',
                flexShrink: 0,
                lineHeight: 1.4,
              }}
            >
              <input
                type="checkbox"
                checked={autoEnabled}
                disabled={busy || autoSaving}
                onChange={(e) => setAutoEnabled(e.target.checked)}
                style={{ flexShrink: 0 }}
              />
              <span>每日自动入库</span>
            </label>
            <select
              value={autoHour}
              disabled={busy || autoSaving}
              onChange={(e) => setAutoHour(parseInt(e.target.value, 10))}
              style={{
                padding: '6px 10px',
                borderRadius: 8,
                border: '1px solid #555',
                background: '#1a1a1e',
                color: '#eee',
                fontSize: 12,
              }}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || autoSaving}
              onClick={handleSaveAuto}
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                border: '1px solid #3db8d9',
                background: '#1a4d5c',
                color: '#7ee8fc',
                fontSize: 12,
                fontWeight: 'bold',
                cursor: busy || autoSaving ? 'not-allowed' : 'pointer',
              }}
            >
              {autoSaving ? '保存中…' : '保存定时'}
            </button>
            <span style={{ fontSize: 11, color: '#666' }}>
              每日自动检查一次（北京时间约 03:00）；仅当所选整点为 3 点且有待入库时执行
            </span>
          </div>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onTabChange(t.id)}
            style={{
              padding: '8px 14px',
              borderRadius: '8px',
              border: tab === t.id ? '1px solid #3db8d9' : '1px solid #555',
              background: tab === t.id ? 'rgba(61,184,217,0.15)' : '#2a2a2e',
              color: tab === t.id ? '#7ee8fc' : '#aaa',
              fontSize: '12px',
              fontWeight: 'bold',
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {busy && progress ? (
        <div
          style={{
            marginBottom: 16,
            padding: '12px 14px',
            background: '#1a4d5c',
            borderRadius: '8px',
            border: '1px solid #3db8d9',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#7ee8fc', marginBottom: 8, gap: 12 }}>
            <span style={{ fontWeight: 700 }}>入库进行中…</span>
            <span style={{ color: '#bde8f5', whiteSpace: 'nowrap' }}>
              本次 {sessionDone} / {progress.initialPending}
            </span>
          </div>
          {progress.currentTitle ? (
            <div
              style={{
                fontSize: 13,
                color: '#fff',
                marginBottom: 8,
                lineHeight: 1.45,
                wordBreak: 'break-all',
              }}
            >
              正在入库：{progress.currentTitle}
            </div>
          ) : null}
          <div style={{ height: 6, background: '#0d2a33', borderRadius: 3, overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${progressPct}%`,
                background: 'linear-gradient(90deg, #3db8d9, #7ee8fc)',
                transition: 'width 0.35s ease',
              }}
            />
          </div>
          <p style={{ marginTop: 8, fontSize: 11, color: '#aaa', lineHeight: 1.5 }}>
            本次成功 {progress.sessionSucceeded ?? 0} · 本次失败 {progress.sessionFailed ?? 0}
            {progress.currentIndex > 0 ? ` · 当前第 ${progress.currentIndex} 条` : ''}
          </p>
          <p style={{ marginTop: 4, fontSize: 11, color: '#888' }}>
            队列：待入库 {pendingCount} · 处理中 {processingCount} · 失败 {failedCount}
          </p>
        </div>
      ) : null}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <button
          type="button"
          className="cover-modal-btn cover-modal-btn-secondary"
          onClick={() => onRefresh(tab)}
          disabled={busy}
        >
          {busy ? '刷新中…' : '刷新'}
        </button>
        {tab === 'pending' && configured ? (
          <>
            <button
              type="button"
              disabled={busy || pendingCount <= 0}
              onClick={onIngestAll}
              style={{
                padding: '10px 16px',
                borderRadius: '10px',
                border: '1px solid #3db8d9',
                background: busy || pendingCount <= 0 ? '#333' : '#3db8d9',
                color: '#fff',
                fontWeight: 'bold',
                fontSize: '13px',
                cursor: busy || pendingCount <= 0 ? 'not-allowed' : 'pointer',
              }}
            >
              {busy ? '入库中…' : `全部入库（${pendingCount}）`}
            </button>
            <button
              type="button"
              disabled={busy || selectedCount <= 0}
              onClick={onIngestSelected}
              style={{
                padding: '10px 16px',
                borderRadius: '10px',
                border: '1px solid #7ee8fc',
                background: 'transparent',
                color: '#7ee8fc',
                fontWeight: 'bold',
                fontSize: '13px',
                cursor: busy || selectedCount <= 0 ? 'not-allowed' : 'pointer',
                opacity: busy || selectedCount <= 0 ? 0.45 : 1,
              }}
            >
              入库所选（{selectedCount}）
            </button>
            <button
              type="button"
              disabled={busy || selectedCount <= 0}
              onClick={onDeleteSelected}
              style={{
                padding: '10px 16px',
                borderRadius: '10px',
                border: '1px solid #f87171',
                background: 'transparent',
                color: '#f87171',
                fontWeight: 'bold',
                fontSize: '13px',
                cursor: busy || selectedCount <= 0 ? 'not-allowed' : 'pointer',
                opacity: busy || selectedCount <= 0 ? 0.45 : 1,
              }}
            >
              删除所选（{selectedCount}）
            </button>
            <button
              type="button"
              disabled={busy || !pendingItems.length}
              onClick={onSelectAllPending}
              style={{
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid #555',
                background: '#2a2a2e',
                color: '#ccc',
                fontSize: '12px',
                cursor: busy || !pendingItems.length ? 'not-allowed' : 'pointer',
              }}
            >
              全选待入库
            </button>
          </>
        ) : null}
        {tab === 'failed' && configured ? (
          <>
            <button
              type="button"
              disabled={busy || selectedCount <= 0}
              onClick={onRetrySelected}
              style={{
                padding: '10px 16px',
                borderRadius: '10px',
                border: '1px solid #7ee8fc',
                background: 'transparent',
                color: '#7ee8fc',
                fontWeight: 'bold',
                fontSize: '13px',
                cursor: busy || selectedCount <= 0 ? 'not-allowed' : 'pointer',
                opacity: busy || selectedCount <= 0 ? 0.45 : 1,
              }}
            >
              重新加入队列（{selectedCount}）
            </button>
            <button
              type="button"
              disabled={busy || !failedItems.length}
              onClick={onSelectAllFailed}
              style={{
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid #555',
                background: '#2a2a2e',
                color: '#ccc',
                fontSize: '12px',
                cursor: busy || !failedItems.length ? 'not-allowed' : 'pointer',
              }}
            >
              全选失败项
            </button>
          </>
        ) : null}
        {tab === 'processing' && configured ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={onReclaimStale}
              style={{
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid #fbbf24',
                background: 'transparent',
                color: '#fbbf24',
                fontSize: '12px',
                fontWeight: 'bold',
                cursor: busy ? 'not-allowed' : 'pointer',
              }}
            >
              纠正超时任务
            </button>
            <button
              type="button"
              disabled={busy || selectedCount <= 0}
              onClick={onResetProcessingSelected}
              style={{
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid #7ee8fc',
                background: 'transparent',
                color: '#7ee8fc',
                fontSize: '12px',
                cursor: busy || selectedCount <= 0 ? 'not-allowed' : 'pointer',
              }}
            >
              重置为待入库（{selectedCount}）
            </button>
            <button
              type="button"
              disabled={busy || !processingItems.length}
              onClick={() => onSelectAllProcessing?.()}
              style={{
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid #555',
                background: '#2a2a2e',
                color: '#ccc',
                fontSize: '12px',
                cursor: busy || !processingItems.length ? 'not-allowed' : 'pointer',
              }}
            >
              全选处理中
            </button>
          </>
        ) : null}
        {selectableTab && selectedCount > 0 ? (
          <button type="button" disabled={busy} onClick={onClearSelection} style={{ fontSize: 12, color: '#888', background: 'none', border: 'none', cursor: 'pointer' }}>
            清空选择
          </button>
        ) : null}
        {busy && onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid #f87171',
              background: 'transparent',
              color: '#f87171',
              fontSize: 12,
              fontWeight: 'bold',
              cursor: 'pointer',
            }}
          >
            停止入库
          </button>
        ) : null}
      </div>

      <p style={{ fontSize: 11, color: '#777', marginBottom: 12, lineHeight: 1.5 }}>
        全部入库将逐条连续处理直至完成或达到单次上限（约 4.5 分钟）；处理中超过 5 分钟无更新会自动标记为失败。
        {busy ? ' 入库进行中可点「刷新」查看实时状态。' : ''}
      </p>

      <div style={{ maxHeight: '520px', overflow: 'auto', border: '1px solid #444', borderRadius: 8, background: '#2a2a2e' }}>
        {!listRows || listRows.length === 0 ? (
          <p style={{ padding: 16, color: '#888', fontSize: 13, textAlign: 'center' }}>
            {tab === 'pending' ? '暂无待入库元数据' : tab === 'processing' ? '暂无处理中任务' : tab === 'failed' ? '暂无失败记录' : '暂无入库记录'}
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#333', color: '#ccc', textAlign: 'left' }}>
                {selectableTab || tab === 'processing' ? <th style={{ padding: '8px 10px', width: 36 }} /> : null}
                <th style={{ padding: '8px 10px' }}>状态</th>
                <th style={{ padding: '8px 10px' }}>标题</th>
                <th style={{ padding: '8px 10px' }}>slug</th>
                <th style={{ padding: '8px 10px' }}>图</th>
                <th style={{ padding: '8px 10px' }}>更新时间</th>
                <th style={{ padding: '8px 10px' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {listRows.map((row) =>
                renderRow(row, {
                  selectable: selectableTab || tab === 'processing',
                  showRetry: tab === 'log',
                })
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

/** 顶栏：刷新前台按钮（点击即刷新，无下拉） */
const AdminRefreshButton = ({
  isThemeLoading,
  blogRefreshBusy,
  blogRefreshCooldownSec,
  onShellRefresh,
}) => {
  const disabled = isThemeLoading || blogRefreshBusy || blogRefreshCooldownSec > 0;
  const title =
    blogRefreshCooldownSec > 0
      ? `刷新前台:更新首页、自定义页面、归档与分类/标签列表 · 冷却中（${formatRefreshCooldownHint(blogRefreshCooldownSec)}）`
      : '刷新前台:更新首页、自定义页面、归档与分类/标签列表';
  return (
    <button
      type="button"
      className="header-actions-trigger"
      onClick={onShellRefresh}
      disabled={disabled}
      aria-label="刷新前台"
      title={title}
    >
      {blogRefreshBusy ? (
        <span style={blogRefreshSpinStyle} aria-hidden />
      ) : (
        <Icons.Refresh />
      )}
    </button>
  );
};

/** 标题右侧齿轮下拉菜单：爬虫设置 + 新手引导（占位入口） */
const AdminGearMenu = ({
  wrapRef,
  open,
  onToggle,
  onClose,
  isThemeLoading,
  crawlerIngestBusy,
  crawlerIngestProgress,
  crawlerIngestConfigured,
  crawlerIngestSummary,
  onOpenIngestList,
  onShowOnboarding,
}) => {
  const crawlerIngestDisabled = isThemeLoading || !crawlerIngestConfigured;
  const crawlerSessionDone =
    crawlerIngestProgress
      ? (crawlerIngestProgress.sessionSucceeded ?? 0) +
        (crawlerIngestProgress.sessionFailed ?? 0)
      : 0;

  const runAndClose = (fn) => {
    onClose();
    fn();
  };

  return (
    <div className="header-actions-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="header-actions-gear-trigger"
        onClick={onToggle}
        disabled={isThemeLoading}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Icons.Settings />
      </button>
      {open ? (
        <div className="header-actions-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="header-actions-menu-item"
            disabled={crawlerIngestDisabled}
            onClick={() => runAndClose(onOpenIngestList)}
            title={
              !crawlerIngestConfigured
                ? '入库服务尚未配置，请联系管理'
                : '爬虫入库管理：待入库、处理中、失败与入库记录'
            }
          >
            {crawlerIngestBusy && crawlerIngestProgress ? (
              <>
                入库中
                <span className="header-actions-menu-item__hint">
                  本次 {crawlerSessionDone} / {crawlerIngestProgress.initialPending}
                  {crawlerIngestProgress.currentTitle
                    ? ` · ${crawlerIngestProgress.currentTitle}`
                    : ''}
                </span>
              </>
            ) : (
              '爬虫设置'
            )}
            {crawlerIngestConfigured && crawlerIngestSummary && !crawlerIngestBusy ? (
              <span className="header-actions-menu-item__hint">
                待入库 {crawlerIngestSummary.pending ?? 0} · 处理中{' '}
                {crawlerIngestSummary.processing ?? 0} · 失败{' '}
                {crawlerIngestSummary.failed ?? 0}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            role="menuitem"
            className="header-actions-menu-item"
            onClick={() => runAndClose(onShowOnboarding)}
          >
            新手引导
          </button>
        </div>
      ) : null}
    </div>
  );
};

/** 爬虫管理维护密码弹窗 */
const CrawlerIngestUnlockModal = ({
  open,
  closing,
  busy,
  passwordError,
  onConfirm,
  onCancel,
}) => {
  const [visible, setVisible] = useState(false);
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (open && !closing) {
      setVisible(false);
      setPassword('');
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
      return () => cancelAnimationFrame(id);
    }
    if (!open || closing) setVisible(false);
  }, [open, closing]);

  if (!open && !closing) return null;

  const submit = () => {
    if (busy) return;
    onConfirm(password.trim());
  };

  return (
    <div
      className={`cover-modal-backdrop ${visible && !closing ? 'is-visible' : ''} ${closing ? 'is-closing' : ''}`}
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="cover-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="crawler-unlock-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cover-modal-icon" aria-hidden>🔐</div>
        <h3 id="crawler-unlock-modal-title" className="cover-modal-title">解锁爬虫管理</h3>
        <p className="cover-modal-desc">
          爬虫入库会批量更新文章与图库，请输入维护密码后继续。
        </p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          disabled={busy}
          placeholder="请输入维护密码"
          autoComplete="off"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            marginTop: '12px',
            padding: '12px 14px',
            borderRadius: '10px',
            border: `1px solid ${passwordError ? '#ff7875' : 'rgba(255,255,255,0.18)'}`,
            background: '#151515',
            color: '#f5f5f5',
            outline: 'none',
          }}
        />
        {passwordError ? (
          <p style={{ margin: '8px 0 0', color: '#ff7875', fontSize: '12px' }}>
            {passwordError}
          </p>
        ) : null}
        <div className="cover-modal-actions">
          <button type="button" className="cover-modal-btn cover-modal-btn-secondary" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="cover-modal-btn"
            onClick={submit}
            disabled={busy}
            style={{
              background: busy ? '#5a4a6e' : '#9a6dd7',
              color: '#fff',
              boxShadow: busy ? 'none' : '0 4px 14px rgba(154,109,215,0.35)',
            }}
          >
            {busy ? '验证中…' : '解锁'}
          </button>
        </div>
      </div>
    </div>
  );
};

/** 主题切换完成提示（替代浏览器 alert） */
const VendingAddressUnlockModal = ({
  open,
  closing,
  busy,
  passwordError,
  onConfirm,
  onCancel,
}) => {
  const [visible, setVisible] = useState(false);
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (open && !closing) {
      setVisible(false);
      setPassword('');
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
      return () => cancelAnimationFrame(id);
    }
    if (!open || closing) setVisible(false);
  }, [open, closing]);

  if (!open && !closing) return null;

  const submit = () => {
    if (busy) return;
    onConfirm(password.trim());
  };

  return (
    <div
      className={`cover-modal-backdrop ${visible && !closing ? 'is-visible' : ''} ${closing ? 'is-closing' : ''}`}
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="cover-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vending-address-unlock-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cover-modal-icon" aria-hidden>🔐</div>
        <h3 id="vending-address-unlock-title" className="cover-modal-title">解锁贩售机地址</h3>
        <p className="cover-modal-desc">
          贩售机地址会影响统一分发与收款入口。请输入维护密码后再编辑地址或按钮名称。
        </p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          disabled={busy}
          placeholder="请输入维护密码"
          autoComplete="off"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            marginTop: '12px',
            padding: '12px 14px',
            borderRadius: '10px',
            border: `1px solid ${passwordError ? '#ff7875' : 'rgba(255,255,255,0.18)'}`,
            background: '#151515',
            color: '#f5f5f5',
            outline: 'none',
          }}
        />
        {passwordError ? (
          <p style={{ margin: '8px 0 0', color: '#ff7875', fontSize: '12px' }}>
            {passwordError}
          </p>
        ) : null}
        <div className="cover-modal-actions">
          <button type="button" className="cover-modal-btn cover-modal-btn-secondary" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="cover-modal-btn"
            onClick={submit}
            disabled={busy}
            style={{
              background: busy ? '#5a4a6e' : '#9a6dd7',
              color: '#fff',
              boxShadow: busy ? 'none' : '0 4px 14px rgba(154,109,215,0.35)',
            }}
          >
            {busy ? '验证中…' : '解锁'}
          </button>
        </div>
      </div>
    </div>
  );
};

const ThemeSwitchDoneModal = ({ open, closing, extraNote, onClose }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open && !closing) {
      setVisible(false);
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
      return () => cancelAnimationFrame(id);
    }
    if (!open || closing) setVisible(false);
  }, [open, closing]);

  if (!open && !closing) return null;

  return (
    <div
      className={`cover-modal-backdrop ${visible && !closing ? 'is-visible' : ''} ${closing ? 'is-closing' : ''}`}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="cover-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="theme-done-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cover-modal-icon" aria-hidden>🎨</div>
        <h3 id="theme-done-modal-title" className="cover-modal-title">主题切换完成</h3>
        <p className="cover-modal-desc">
          BLOG主题已切换。
          <br /><br />
          若博客首页仍显示旧主题，请在博客页按 <strong>Ctrl+Shift+R</strong>（Mac：<strong>Cmd+Shift+R</strong>）强制刷新，或新开标签页访问。
          <br /><br />
          各篇<strong>内页</strong>会逐步完成更新（通常 1 小时内）；也可直接打开该篇内页触发立即更新。
          {extraNote ? (
            <>
              <br /><br />
              <span style={{ color: '#ccc' }}>{extraNote}</span>
            </>
          ) : null}
        </p>
        <div className="cover-modal-actions">
          <button type="button" className="cover-modal-btn cover-modal-btn-primary" onClick={onClose} style={{ flex: 1 }}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
};

// 工具函数：清洗 URL1
// 🟢 修复版：AdminDashboard 顶部的洗链逻辑
const cleanAndFormat = (input) => {
  if (!input) return "";
  const lines = input.split('\n').map(line => {
    let raw = line.trim();
    if (!raw) return ""; 
    
    // 1. 提取 URL
    const mdMatch = raw.match(/\[.*?\]\((.*?)\)/);
    let urlCandidate = mdMatch ? mdMatch[1] : raw;
    const urlMatch = urlCandidate.match(/https?:\/\/[^\s"']+/);
    
    if(urlMatch) {
      let finalUrl = urlMatch[0];
      
      // 2. 强制转义中括号，防止 Notion 报错
      if (/[\[\]]/.test(finalUrl)) {
        try {
          finalUrl = encodeURI(decodeURI(finalUrl));
        } catch(e) {
          finalUrl = encodeURI(finalUrl);
        }
      }
      
      // 3. 包装成标准格式
      if (/\.(jpg|jpeg|png|gif|webp|bmp|svg|mp4|mov|webm|ogg|mkv)(\?|$)/i.test(finalUrl)) {
         return `![](${finalUrl})`;
      }
      return finalUrl;
    }
    return raw;
  });
  return lines.filter(l=>l).join('\n');
};

// 工具函数：判断某一行是否为「纯图片」(markdown 图片或裸图片链接)，是则返回 URL
const extractImageUrl = (str) => {
  if (!str) return null;
  let s = str.trim();
  const md = s.match(/^!\[.*?\]\((.*?)\)$/);
  if (md) s = md[1].trim();
  const um = s.match(/^https?:\/\/[^\s"']+$/);
  if (!um) return null;
  const url = um[0];
  return /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|$)/i.test(url) ? url : null;
};

// Notion 文字颜色 -> 编辑器预览用的 CSS 色值
const NOTION_TEXT_COLORS = [
  { key: 'default', label: '默认', css: '#e1e1e3' },
  { key: 'gray', label: '灰', css: '#9b9b9b' },
  { key: 'brown', label: '棕', css: '#b08968' },
  { key: 'orange', label: '橙', css: '#e9954e' },
  { key: 'yellow', label: '黄', css: '#d4b53d' },
  { key: 'green', label: '绿', css: '#4dab6d' },
  { key: 'blue', label: '蓝', css: '#5b9bd5' },
  { key: 'purple', label: '紫', css: '#9a6dd7' },
  { key: 'pink', label: '粉', css: '#e255a1' },
  { key: 'red', label: '红', css: '#ff6b6b' },
];
const colorCss = (key) => (NOTION_TEXT_COLORS.find(c => c.key === key) || NOTION_TEXT_COLORS[0]).css;
const btnSpinStyle = { width: '13px', height: '13px', border: '2px solid rgba(0,0,0,0.25)', borderTopColor: '#000', borderRadius: '50%', display: 'inline-block', animation: 'imgspin 0.8s linear infinite', verticalAlign: 'middle' };
// BLOG 分层 P4-FIX:广告位为专业版权益——免费版管理界面灰态(可见但整体禁用)提示条
const ADS_LOCKED_NOTICE_STYLE = { display:'flex', alignItems:'center', gap:'10px', padding:'14px 16px', background:'rgba(251,191,36,0.08)', border:'1px solid rgba(251,191,36,0.35)', color:'#fbbf24', borderRadius:'12px', fontSize:'13px', lineHeight:1.6, marginBottom:'18px' };
// 可选主题列表（目前用现有的 v1/v2 排版作为主题，后续上新主题往这里加即可）
const ADMIN_THEMES = [
  { id: 'v1', label: 'Standard V1', color: '#3b82f6', desc: '标准排版 · 经典风格' },
  { id: 'v2', label: 'Standard V2', color: '#a855f7', desc: '标准排版 · 现代风格' },
  { id: 'gallery', label: 'Gallery', color: '#f97316', desc: '图库风格 · 卡片直链下载' },
  { id: 'tweet', label: 'tweet·灰色', color: '#6b7280', desc: '时间线卡片 · 灰底可切换深浅' },
  { id: 'tweet-light', label: 'tweet·浅色', color: '#38bdf8', desc: '时间线卡片 · 固定纯白浅色' },
  { id: 'tweet-dark', label: 'tweet·暗', color: '#0f1419', desc: '时间线卡片 · 纯黑 X 暗色风格' },
  { id: 'shop', label: 'shop v1', color: '#22c55e', desc: '商城风格 v1 · 文章关联商品 + 商品卡网格' },
  { id: 'shop-v2', label: 'shop v2', color: '#14b8a6', desc: '商城风格 · 首页单列大卡橱窗' },
];

function formatThemeSwitchQuotaRemaining(remainingMs) {
  if (!remainingMs || remainingMs <= 0) return '';
  const totalMinutes = Math.ceil(remainingMs / (60 * 1000));
  if (totalMinutes >= 60) {
    const hours = Math.ceil(totalMinutes / 60);
    return `已达 24h 切换上限 · 约 ${hours} 小时后可再切换`;
  }
  return `已达 24h 切换上限 · 约 ${totalMinutes} 分钟后可再切换`;
}

function formatThemeSwitchQuotaHint(quota) {
  if (!quota) return '';
  if (quota.blocked) {
    return formatThemeSwitchQuotaRemaining(quota.remainingMs);
  }
  if (quota.remaining < quota.maxSwitches) {
    return `24 小时内还可切换 ${quota.remaining} 次`;
  }
  return `24 小时内最多切换 ${quota.maxSwitches} 次`;
}
const lightSpinStyle = { width: '13px', height: '13px', border: '2px solid rgba(255,255,255,0.25)', borderTopColor: '#fff', borderRadius: '50%', display: 'inline-block', animation: 'imgspin 0.8s linear infinite', verticalAlign: 'middle' };
const blogRefreshSpinStyle = { width: '13px', height: '13px', border: '2px solid rgba(173,255,47,0.25)', borderTopColor: 'greenyellow', borderRadius: '50%', display: 'inline-block', animation: 'imgspin 0.8s linear infinite', verticalAlign: 'middle', flexShrink: 0 };
const fmtStyle = (b) => ({
  fontWeight: b.bold ? 'bold' : 'normal',
  fontStyle: b.italic ? 'italic' : 'normal',
  color: colorCss(b.color),
});

// 块内文字格式工具条 (整块加粗/斜体/颜色)
const FormatBar = ({ b, onChange, onInsertLink }) => (
  <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' }}>
    <button onClick={() => onChange('bold', !b.bold)} title="加粗" style={{ width: '30px', height: '28px', borderRadius: '6px', cursor: 'pointer', border: '1px solid', borderColor: b.bold ? 'greenyellow' : '#444', background: b.bold ? 'greenyellow' : '#2a2a2e', color: b.bold ? '#000' : '#ccc', fontWeight: 'bold' }}>B</button>
    <button onClick={() => onChange('italic', !b.italic)} title="斜体" style={{ width: '30px', height: '28px', borderRadius: '6px', cursor: 'pointer', border: '1px solid', borderColor: b.italic ? 'greenyellow' : '#444', background: b.italic ? 'greenyellow' : '#2a2a2e', color: b.italic ? '#000' : '#ccc', fontStyle: 'italic' }}>I</button>
    {onInsertLink && (
      <button onClick={onInsertLink} title="给选中的文字添加超链接" style={{ height: '28px', padding: '0 8px', borderRadius: '6px', cursor: 'pointer', border: '1px solid #444', background: '#2a2a2e', color: '#7cb3ff', fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>🔗 链接</button>
    )}
    <div style={{ width: '1px', height: '20px', background: '#444', margin: '0 4px' }} />
    {NOTION_TEXT_COLORS.map(c => (
      <div key={c.key} onClick={() => onChange('color', c.key)} title={c.label}
        style={{ width: '18px', height: '18px', borderRadius: '50%', background: c.css, cursor: 'pointer', border: (b.color || 'default') === c.key ? '2px solid greenyellow' : '2px solid #333', boxSizing: 'border-box' }} />
    ))}
  </div>
);

// 工具函数：把加密块正文拆成「纯文本」与「图片URL数组」两部分
const splitLockBody = (body) => {
  const images = [];
  const textLines = [];
  (body || '').split(/\r?\n/).forEach((line) => {
    const u = extractImageUrl(line.trim());
    if (u) images.push(u);
    else textLines.push(line);
  });
  return { text: textLines.join('\n').trim(), images };
};

// ==========================================
// 4. 积木编辑器
// ==========================================
const BLOCK_TYPE_SHORT = {
  h1: 'H1 标题',
  text: '正文',
  image: '图片',
  quote: '引用',
  link: '链接',
  note: '注释',
  lock: '加密',
  ol: '有序',
  ul: '无序',
  todo: '待办',
  toggle: '折叠',
};

const BlockMinimapItem = ({
  block,
  index,
  isCover,
  isDragging,
  isDropBefore,
  isDropAfter,
  justMoved,
  selectMode,
  isSelected,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onClick,
  onRemove,
}) => {
  const previewText = (() => {
    // toggle 的 content 为行数组，统一转成多行字符串再取预览
    const raw = String(
      Array.isArray(block.content) ? block.content.join('\n') : (block.content || '')
    ).trim();
    if (block.type === 'link') return raw || block.url || '';
    if (block.type === 'lock') return raw || (block.images?.length ? `${block.images.length} 张加密图片` : '');
    return raw;
  })();
  const thumbUrl =
    block.type === 'image' && block.content
      ? block.content
      : block.type === 'lock' && block.images?.length
        ? block.images[0]
        : null;
  const isVideoThumb = thumbUrl && isVideoImageContent(thumbUrl);
  const previewClass = [
    'block-minimap-preview',
    block.type === 'h1' ? 'is-h1' : '',
    block.type === 'quote' ? 'is-quote' : '',
    block.type === 'note' ? 'is-note' : '',
    !previewText && !thumbUrl ? 'is-empty' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={`block-minimap-item ${isDragging ? 'is-dragging' : ''} ${isDropBefore ? 'is-drop-before' : ''} ${isDropAfter ? 'is-drop-after' : ''} ${isCover ? 'is-cover' : ''} ${justMoved ? 'just-moved' : ''} ${selectMode ? 'is-select-mode' : ''} ${isSelected ? 'is-selected' : ''}`}
      draggable={!selectMode}
      onDragStart={(e) => { if (selectMode) { e.preventDefault(); return; } onDragStart(e, index); }}
      onDragOver={(e) => { if (selectMode) return; onDragOver(e, index); }}
      onDrop={(e) => { if (selectMode) return; onDrop(e, index); }}
      onDragEnd={onDragEnd}
      onClick={(e) => {
        if (e.target.closest('.block-minimap-del')) return;
        onClick(block.id);
      }}
      title={selectMode ? `第 ${index + 1} 块 · 点击选择/取消` : `第 ${index + 1} 块 · 拖拽排序 · 点击放大编辑`}
    >
      <span className="block-minimap-index">{index + 1}</span>
      {!selectMode ? (
        <button
          type="button"
          className="block-minimap-del"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onRemove(block.id); }}
          title="删除此块"
          aria-label="删除此块"
        >
          ×
        </button>
      ) : null}
      <div className="block-minimap-main">
        <div className="block-minimap-type-row">
          <span className="block-minimap-type">{BLOCK_TYPE_SHORT[block.type] || block.type}</span>
          {isEditorBlockLocked(block) ? <span className="block-minimap-lock" title="已加密">🔒</span> : null}
          {isCover ? <span className="block-minimap-cover">封面</span> : null}
        </div>
        {thumbUrl ? (
          <div className="block-minimap-thumb">
            {isVideoThumb ? <video src={thumbUrl} muted playsInline draggable={false} /> : <img src={thumbUrl} alt="" draggable={false} />}
          </div>
        ) : (
          <div className={previewClass}>{previewText || '（空）'}</div>
        )}
      </div>
    </div>
  );
};

// 后台被包裹在 #admin-container（position:fixed; overflow:auto）中，
// 真正的滚动容器是它而非 window，所以这里直接滚该容器。
// 提升为模块级函数，供主组件右下角悬浮按钮直接调用（避免跨组件作用域报错）。
function scrollEditView(where) {
  if (typeof document === 'undefined') return;
  const container =
    document.getElementById('admin-container') ||
    document.scrollingElement ||
    document.documentElement;
  if (!container) return;
  container.scrollTo({
    top: where === 'top' ? 0 : container.scrollHeight,
    behavior: 'smooth',
  });
}

// 块类型选项（与顶部「添加块」按钮保持一致），用于行内「+添加块」菜单
const BLOCK_TYPE_OPTIONS = [
  { type: 'h1', label: '✨标题块' },
  { type: 'text', label: '📝 内容块' },
  { type: 'image', label: '🖼️ 图片块' },
  { type: 'quote', label: '💭❝引用块' },
  { type: 'link', label: '🔗 超链文字' },
  { type: 'note', label: '💬 注释块' },
  { type: 'lock', label: '🔒 加密块' },
  { type: 'ol', label: '🔢 有序列表' },
  { type: 'ul', label: '• 无序列表' },
  { type: 'todo', label: '☑️ 待办列表' },
  { type: 'toggle', label: '▶ 折叠块' },
];

/** 块类型菜单预估高度，用于判断向上/向下弹出 */
const BLOCK_TYPE_MENU_EST_HEIGHT = 400;
const BLOCK_TYPE_MENU_MIN_WIDTH = 210;

const BlockCoverHint = ({
  coverSettings,
  coverStatusText,
  showManualCoverInput,
  onToggleDefaultCover,
  onToggleManualInput,
  onManualUrlChange,
  onApplyManualUrl,
}) => (
  <div
    className="block-cover-hint"
    style={{
      display: 'flex',
      flexWrap: 'wrap',
      gap: '12px',
      alignItems: 'center',
      justifyContent: 'space-between',
    }}
  >
    <div style={{ flex: '1 1 280px', lineHeight: 1.55 }}>
      <div>
        🖼️ <b style={{ color: 'greenyellow' }}>封面说明</b>：可手动将图库中的图片或正文图片块设定为封面，未手动设定封面则自动采取正文首图或图库首图作为封面。可手动添加外链作为封面或使用系统默认封面。
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
      <button
        type="button"
        className="neo-btn"
        style={{
          fontSize: '12px',
          padding: '6px 12px',
          background: coverSettings.mode === COVER_MODE_DEFAULT ? '#7dd3fc' : undefined,
        }}
        onClick={() => onToggleDefaultCover(coverSettings.mode !== COVER_MODE_DEFAULT)}
      >
        {coverSettings.mode === COVER_MODE_DEFAULT ? '✓ 已启用默认封面' : '启用默认封面'}
      </button>
      <button
        type="button"
        className="neo-btn"
        style={{
          fontSize: '12px',
          padding: '6px 12px',
          background: coverSettings.mode === COVER_MODE_URL ? '#7dd3fc' : undefined,
        }}
        onClick={onToggleManualInput}
      >
        手动添加封面
      </button>
      {showManualCoverInput ? (
        <>
          <input
            className="glow-input"
            style={{ width: '220px', fontSize: '12px', padding: '6px 10px' }}
            placeholder="https://图片直链"
            value={coverSettings.manualUrl}
            onChange={(e) => onManualUrlChange(e.target.value)}
          />
          <button
            type="button"
            className="neo-btn"
            style={{ fontSize: '12px', padding: '6px 12px' }}
            onClick={onApplyManualUrl}
          >
            确认
          </button>
        </>
      ) : null}
    </div>
  </div>
  </div>
);

const isFileDragEvent = (e) => {
  const dt = e.dataTransfer;
  if (!dt?.types) return false;
  return Array.from(dt.types).includes('Files');
};

// Phase5 粘贴自动分块：识别多行统一前缀（有序/无序/待办/标题）
// 规则：粘贴文本 ≥2 行且 ≥2 行匹配同一前缀才转换；不满足返回 null（按普通文本粘贴）
const PASTE_PREFIX_RULES = [
  { type: 'todo', re: /^\[([xX ])\][ \t]+/ },
  { type: 'ol', re: /^\d+[.、)][ \t]+/ },
  { type: 'ul', re: /^[-*•][ \t]+/ },
  { type: 'h1', re: /^#[ \t]+/ },
];
function detectPastedBlockConversion(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.replace(/\r\n?/g, '\n').trim();
  if (!trimmed) return null;
  const lines = trimmed.split('\n');
  if (lines.length < 2) return null;
  const matched = PASTE_PREFIX_RULES.map((rule) => ({
    ...rule,
    count: lines.filter((l) => rule.re.test(l)).length,
  })).sort((a, b) => b.count - a.count);
  const best = matched[0];
  if (!best || best.count < 2) return null;
  const res = { type: best.type, lines: [], checked: [] };
  lines.forEach((l) => {
    const m = l.match(best.re);
    if (m) {
      res.lines.push(l.slice(m[0].length));
      if (best.type === 'todo') res.checked.push(m[1].toLowerCase() === 'x');
    } else {
      res.lines.push(l);
      if (best.type === 'todo') res.checked.push(false);
    }
  });
  return res;
}

const BlockBuilder = ({
  blocks,
  setBlocks,
  coverMode,
  coverImageBlockId,
  onSetBodyCover,
  onClearBodyCover,
  onToast,
}) => {
  const [movingId, setMovingId] = useState(null);
  const [blockViewMode, setBlockViewMode] = useState('expanded');
  const [dragIndex, setDragIndex] = useState(null);
  const [dropIndex, setDropIndex] = useState(null);
  const [dropPosition, setDropPosition] = useState(null);
  const [fileDropIndex, setFileDropIndex] = useState(null);
  const [fileDropPosition, setFileDropPosition] = useState(null);
  const [fileDropEmpty, setFileDropEmpty] = useState(false);
  const [compactMultiSelect, setCompactMultiSelect] = useState(false);
  const [compactSelectedIds, setCompactSelectedIds] = useState([]);
  const minimapDragMovedRef = useRef(false);
  // 行内超链接弹窗：{ blockId, start, end, label, url }，为 null 时关闭
  const [linkModal, setLinkModal] = useState(null);
  const [lockModal, setLockModal] = useState(null);
  // Phase5 折叠块预览展开状态：{ [blockId]: true }
  const [toggleOpenMap, setToggleOpenMap] = useState({});

  const scrollToBlock = (id, delay = 100) => {
    setTimeout(() => {
       const el = document.getElementById(`block-${id}`);
       if(el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, delay);
  };

  const focusBlockInExpandedView = (blockId) => {
    setBlockViewMode('expanded');
    setMovingId(blockId);
    scrollToBlock(blockId, 180);
    setTimeout(() => setMovingId(null), 700);
  };

  const addBlock = (type) => {
    const newBlock = createEditorBlock(type);
    setBlocks([...blocks, newBlock]);
    setBlockViewMode('expanded');
    scrollToBlock(newBlock.id);
  };

  // 行内「+添加块」菜单：值为菜单 key（插入位置由 toggle 时传入的回调决定）
  const [addMenuFor, setAddMenuFor] = useState(null);
  const [addMenuLayout, setAddMenuLayout] = useState(null);
  const addMenuPickRef = useRef(null);

  const closeAddMenu = () => {
    setAddMenuFor(null);
    setAddMenuLayout(null);
    addMenuPickRef.current = null;
  };

  const toggleAddMenu = (menuKey, event, onPick) => {
    event.stopPropagation();
    if (addMenuFor === menuKey) {
      closeAddMenu();
      return;
    }
    const el = event.currentTarget;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openAbove =
      spaceBelow < BLOCK_TYPE_MENU_EST_HEIGHT && spaceAbove >= spaceBelow;
    const anchorY = openAbove ? rect.top - 8 : rect.bottom + 8;
    const halfW = BLOCK_TYPE_MENU_MIN_WIDTH / 2;
    const left = Math.max(
      halfW + 8,
      Math.min(rect.left + rect.width / 2, window.innerWidth - halfW - 8)
    );
    addMenuPickRef.current = onPick;
    setAddMenuLayout({ left, anchorY, openAbove });
    setAddMenuFor(menuKey);
  };

  const pickBlockType = (type) => {
    const pick = addMenuPickRef.current;
    closeAddMenu();
    if (pick) pick(type);
  };

  // 在指定下标之后插入新块；index 传 -1 表示插到最前
  const addBlockAfter = (index, type, options = {}) => {
    const newBlock = createEditorBlock(type);
    setBlocks([...blocks.slice(0, index + 1), newBlock, ...blocks.slice(index + 1)]);
    closeAddMenu();
    if (options.stayCompact || blockViewMode === 'compact') {
      setMovingId(newBlock.id);
      setTimeout(() => setMovingId(null), 600);
    } else {
      setBlockViewMode('expanded');
      scrollToBlock(newBlock.id);
    }
  };

  const renderMinimapAddBtn = (menuKey, afterIndex) => (
    <div key={menuKey} className="block-minimap-add-wrap">
      <button
        type="button"
        className={`block-minimap-add-btn ${addMenuFor === menuKey ? 'open' : ''}`}
        title="在此处添加块"
        onClick={(e) =>
          toggleAddMenu(menuKey, e, (type) =>
            addBlockAfter(afterIndex, type, { stayCompact: true })
          )
        }
      >
        ＋
      </button>
    </div>
  );

  const renderCompactMinimapToolbar = () => (
    <div className="block-minimap-toolbar">
      <button
        type="button"
        className={`block-compact-select-toggle${compactMultiSelect ? ' is-active' : ''}`}
        onClick={toggleCompactMultiSelect}
        aria-pressed={compactMultiSelect}
        title={compactMultiSelect ? '退出多选模式' : '多选内容块以批量删除'}
      >
        {compactMultiSelect
          ? compactSelectedIds.length
            ? `多选中 · 已选 ${compactSelectedIds.length} 项`
            : '多选中'
          : '多选'}
      </button>
      {compactMultiSelect ? (
        <button
          type="button"
          className="block-compact-multiselect-del"
          disabled={!compactSelectedIds.length}
          onClick={removeSelectedBlocks}
        >
          删除选中
        </button>
      ) : (
        <span />
      )}
    </div>
  );

  const renderFloatingBlockTypeMenu = () => {
    if (!addMenuFor || !addMenuLayout) return null;
    const { left, anchorY, openAbove } = addMenuLayout;
    const menuStyle = {
      left,
      transform: 'translateX(-50%)',
      ...(openAbove
        ? { bottom: window.innerHeight - anchorY }
        : { top: anchorY }),
    };
    return (
      <>
        <div className="block-add-menu-backdrop" onClick={closeAddMenu} />
        <div
          className="block-type-menu block-type-menu-floating"
          style={menuStyle}
          onClick={(e) => e.stopPropagation()}
        >
          {BLOCK_TYPE_OPTIONS.map((opt) => (
            <div
              key={opt.type}
              className="bt-item"
              onClick={() => pickBlockType(opt.type)}
            >
              {opt.label}
            </div>
          ))}
        </div>
      </>
    );
  };
  const updateBlock = (id, val, key='content') => {
    setBlocks(blocks.map(b => {
      if (b.id !== id) return b;
      const next = { ...b, [key]: val };
      // M4: todo 块 content 行数变化时同步 checked 数组长度，避免越界与保存错位
      if (b.type === 'todo' && key === 'content') {
        const lineCount = String(val || '').split(/\r?\n/).length;
        const checkedArr = Array.isArray(b.checked) ? b.checked.slice() : [];
        if (checkedArr.length < lineCount) {
          while (checkedArr.length < lineCount) checkedArr.push(false);
        } else if (checkedArr.length > lineCount) {
          checkedArr.length = lineCount;
        }
        next.checked = checkedArr;
      }
      return next;
    }));
  };

  // Phase5 待办行内勾选：点击行首符号切换 checked[i]；行内 [x]/[ ] 前缀剥离，状态统一存 checked 数组
  const toggleTodoChecked = (blockId, lineIndex) => {
    setBlocks(prev => prev.map((blk) => {
      if (blk.id !== blockId || blk.type !== 'todo') return blk;
      const lines = String(blk.content || '').split(/\r?\n/);
      const checkedArr = Array.isArray(blk.checked) ? [...blk.checked] : [];
      const m = String(lines[lineIndex] || '').match(/^\[([xX ])\][ \t]?/);
      const current = m ? m[1].toLowerCase() === 'x' : !!checkedArr[lineIndex];
      if (m) lines[lineIndex] = String(lines[lineIndex] || '').slice(m[0].length);
      checkedArr[lineIndex] = !current;
      return { ...blk, content: lines.join('\n'), checked: checkedArr };
    }));
  };

  // Phase5 粘贴自动分块：把当前 text 块转为识别出的块类型
  const applyPastedBlockConversion = (blockId, conv) => {
    if (!conv) return;
    setBlocks(prev => prev.map((b) => {
      if (b.id !== blockId || b.type !== 'text') return b;
      if (conv.type === 'todo') {
        return { ...b, type: 'todo', content: conv.lines.join('\n'), checked: conv.checked };
      }
      if (conv.type === 'h1') {
        return { ...b, type: 'h1', content: conv.lines.join('\n') };
      }
      return { ...b, type: conv.type, content: conv.lines.join('\n') };
    }));
    if (onToast) {
      onToast(conv.type === 'h1' ? '已识别为标题块' : '已识别为列表');
    }
  };

  // 给当前块（h1/正文/引用/注释）选中的文字插入行内超链接，写成 [文字](url)
  // 点击「🔗 链接」时先捕获当前选区，再弹出页内弹窗（而非浏览器 prompt）
  const insertLinkForBlock = (b) => {
    const el = typeof document !== 'undefined' ? document.getElementById('editfield-' + b.id) : null;
    const content = b.content || '';
    let start = content.length;
    let end = content.length;
    if (el && typeof el.selectionStart === 'number') {
      start = el.selectionStart;
      end = el.selectionEnd;
    }
    const selected = content.slice(start, end);
    setLinkModal({ blockId: b.id, start, end, label: selected || '', url: 'https://' });
  };

  // 弹窗「确认」：把 [文字](url) 写回对应块，并恢复光标位置
  const confirmLinkModal = () => {
    if (!linkModal) return;
    const { blockId, start, end } = linkModal;
    const label = (linkModal.label || '').trim();
    let url = (linkModal.url || '').trim();
    if (!label || !url || url === 'https://') return;
    const block = blocks.find(x => x.id === blockId);
    if (!block) { setLinkModal(null); return; }
    const content = block.content || '';
    const snippet = `[${label}](${url})`;
    const next = content.slice(0, start) + snippet + content.slice(end);
    updateBlock(blockId, next);
    setLinkModal(null);
    setTimeout(() => {
      const el2 = document.getElementById('editfield-' + blockId);
      if (el2) {
        const pos = start + snippet.length;
        el2.focus();
        try { el2.setSelectionRange(pos, pos); } catch (e) {}
      }
    }, 0);
  };

  const openLockModal = (b) => {
    setLockModal({
      blockId: b.id,
      blockType: b.type,
      pwd: getEditorBlockLockPwd(b),
      isLocked: isEditorBlockLocked(b),
    });
  };

  const confirmLockModal = () => {
    if (!lockModal) return;
    const pwd = (lockModal.pwd || '').trim();
    setBlocks(blocks.map((b) => {
      if (b.id !== lockModal.blockId) return b;
      if (b.type === 'lock') {
        return { ...b, pwd, lockPwd: pwd };
      }
      return { ...b, locked: true, lockPwd: pwd };
    }));
    setLockModal(null);
  };

  const unlockBlockFromModal = () => {
    if (!lockModal) return;
    setBlocks(blocks.map((b) => {
      if (b.id !== lockModal.blockId) return b;
      if (b.type === 'lock') return b;
      return { ...b, locked: false, lockPwd: '' };
    }));
    setLockModal(null);
  };

  const removeBlock = (id) => {
    setBlocks(prev => {
      const block = prev.find(b => b.id === id);
      if (block) revokeBlockPendingMedia(block);
      return prev.filter(b => b.id !== id);
    });
    setCompactSelectedIds(prev => prev.filter(x => x !== id));
  };

  const toggleCompactMultiSelect = () => {
    clearFileDrop();
    setCompactMultiSelect(prev => {
      if (prev) setCompactSelectedIds([]);
      return !prev;
    });
  };

  const toggleCompactBlockSelect = (id) => {
    setCompactSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const removeSelectedBlocks = () => {
    if (!compactSelectedIds.length) return;
    const idSet = new Set(compactSelectedIds);
    setBlocks(prev => {
      prev.forEach(b => {
        if (idSet.has(b.id)) revokeBlockPendingMedia(b);
      });
      return prev.filter(b => !idSet.has(b.id));
    });
    setCompactSelectedIds([]);
  };

  const exitCompactMultiSelect = () => {
    setCompactMultiSelect(false);
    setCompactSelectedIds([]);
  };

  // === 🖼️ 图片：本地预览，发布/保存时再上传图床 ===
  const assignPendingToBlock = (blockId, file) => {
    const previewUrl = URL.createObjectURL(file);
    setBlocks(prev => prev.map(b => {
      if (b.id !== blockId) return b;
      if (b.pendingFile && b.content?.startsWith('blob:')) URL.revokeObjectURL(b.content);
      return {
        ...b,
        content: previewUrl,
        pendingFile: file,
        uploading: false,
        error: '',
      };
    }));
  };

  const insertImageBlocksAfter = (blockId, fileList) => {
    const files = Array.from(fileList || []).filter(f => /^(image|video)\//i.test(f.type));
    if (!files.length) return;
    const created = files.map(createPendingImageBlock);
    setBlocks(prev => {
      const idx = prev.findIndex(b => b.id === blockId);
      const next = [...prev];
      next.splice(idx === -1 ? next.length : idx + 1, 0, ...created);
      return next;
    });
    scrollToBlock(created[created.length - 1].id);
  };

  const clearFileDrop = () => {
    setFileDropIndex(null);
    setFileDropPosition(null);
    setFileDropEmpty(false);
  };

  const insertImageBlocksAt = (insertIndex, fileList) => {
    const files = Array.from(fileList || []).filter(f => /^(image|video)\//i.test(f.type));
    if (!files.length) return;
    const created = files.map(createPendingImageBlock);
    setBlocks(prev => {
      const idx = Math.max(0, Math.min(insertIndex, prev.length));
      const next = [...prev];
      next.splice(idx, 0, ...created);
      return next;
    });
    setBlockViewMode('expanded');
    scrollToBlock(created[created.length - 1].id);
  };

  const handleFileDropAt = (e, insertIndex) => {
    e.preventDefault();
    e.stopPropagation();
    const files = extractImageFilesFromDataTransfer(e.dataTransfer);
    if (!files.length) {
      clearFileDrop();
      return;
    }
    insertImageBlocksAt(insertIndex, files);
    clearFileDrop();
  };

  const handleEmptyFileDragOver = (e) => {
    if (compactMultiSelect) return;
    if (!isFileDragEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setFileDropEmpty(true);
    setFileDropIndex(null);
    setFileDropPosition(null);
  };

  const handleExpandedFileDragOver = (e, index) => {
    if (!isFileDragEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    setFileDropIndex(index);
    setFileDropPosition(position);
    setFileDropEmpty(false);
  };

  const handleExpandedFileDrop = (e, index) => {
    const files = extractImageFilesFromDataTransfer(e.dataTransfer);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    const insertAt = position === 'after' ? index + 1 : index;
    handleFileDropAt(e, insertAt);
  };

  const resolveExpandedFileInsertFromY = (containerEl, clientY) => {
    const wraps = containerEl?.querySelectorAll?.('.block-card-wrap');
    if (!wraps?.length) return { index: 0, position: 'before' };
    for (let i = 0; i < wraps.length; i++) {
      const rect = wraps[i].getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (clientY < mid) {
        return { index: i, position: 'before' };
      }
    }
    return { index: wraps.length - 1, position: 'after' };
  };

  const applyExpandedFileDropHighlight = (containerEl, clientY) => {
    const { index, position } = resolveExpandedFileInsertFromY(containerEl, clientY);
    setFileDropIndex(index);
    setFileDropPosition(position);
    setFileDropEmpty(false);
  };

  const isBlockDropBefore = (index) =>
    (dropIndex === index && dropPosition === 'before') ||
    (fileDropIndex === index && fileDropPosition === 'before');

  const isBlockDropAfter = (index) =>
    (dropIndex === index && dropPosition === 'after') ||
    (fileDropIndex === index && fileDropPosition === 'after');

  const handleFilesForBlock = (blockId, fileList) => {
    const files = Array.from(fileList || []).filter(f => /^(image|video)\//i.test(f.type));
    if (!files.length) return;
    const [first, ...rest] = files;
    const restBlocks = rest.map(createPendingImageBlock);
    if (restBlocks.length) {
      setBlocks(prev => {
        const idx = prev.findIndex(b => b.id === blockId);
        const next = [...prev];
        next.splice(idx === -1 ? next.length : idx + 1, 0, ...restBlocks);
        return next;
      });
    }
    assignPendingToBlock(blockId, first);
    if (restBlocks.length) scrollToBlock(restBlocks[restBlocks.length - 1].id);
  };

  const extractImageFilesFromDataTransfer = (dt) => {
    if (!dt) return [];
    const out = [];
    if (dt.files?.length) {
      Array.from(dt.files).forEach(f => {
        if (/^(image|video)\//i.test(f.type)) out.push(f);
      });
    }
    if (dt.items?.length) {
      Array.from(dt.items).forEach(item => {
        if (item.kind === 'file' && /^(image|video)\//i.test(item.type)) {
          const f = item.getAsFile();
          if (f && !out.includes(f)) out.push(f);
        }
      });
    }
    return out;
  };

  const extractImageFilesFromClipboard = (clipboardData) => {
    if (!clipboardData?.items) return [];
    const out = [];
    for (let i = 0; i < clipboardData.items.length; i++) {
      const it = clipboardData.items[i];
      if (it.kind === 'file' && /^image\//i.test(it.type)) {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
    return out;
  };

  const appendAndUpload = (fileList) => {
    const files = Array.from(fileList || []).filter(f => /^image\//i.test(f.type));
    if (!files.length) return;
    const created = files.map(createPendingImageBlock);
    setBlocks(prev => [...prev, ...created]);
    scrollToBlock(created[created.length - 1].id);
  };

  const assignPendingToLock = (blockId, fileList) => {
    const files = Array.from(fileList || []).filter(f => /^image\//i.test(f.type));
    if (!files.length) return;
    setBlocks(prev => prev.map(b => {
      if (b.id !== blockId) return b;
      const additions = files.map(file => ({ url: URL.createObjectURL(file), file }));
      return {
        ...b,
        error: '',
        images: [...(b.images || []), ...additions.map(a => a.url)],
        pendingImageFiles: [...(b.pendingImageFiles || []), ...additions],
      };
    }));
  };

  const removeLockImage = (blockId, idx) => {
    setBlocks(prev => prev.map(b => {
      if (b.id !== blockId) return b;
      const url = (b.images || [])[idx];
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
      return {
        ...b,
        images: (b.images || []).filter((_, i) => i !== idx),
        pendingImageFiles: (b.pendingImageFiles || []).filter(p => p.url !== url),
      };
    }));
  };

  // 全局监听：Ctrl+V 粘贴截图（非内容块时追加到文末）
  useEffect(() => {
    const onPaste = (e) => {
      const imgs = extractImageFilesFromClipboard(e.clipboardData);
      if (!imgs.length) return;
      const active = document.activeElement;
      if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return;
      e.preventDefault();
      appendAndUpload(imgs);
    };
    const prevent = (e) => { e.preventDefault(); };
    const onDragEnd = () => clearFileDrop();
    document.addEventListener('paste', onPaste);
    document.addEventListener('dragend', onDragEnd);
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('dragend', onDragEnd);
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  const moveBlock = (index, direction) => {
    if (direction === -1 && index === 0) return;
    if (direction === 1 && index === blocks.length - 1) return;
    const newBlocks = [...blocks];
    const targetIndex = index + direction;
    [newBlocks[index], newBlocks[targetIndex]] = [newBlocks[targetIndex], newBlocks[index]];
    setBlocks(newBlocks);
    setMovingId(newBlocks[targetIndex].id);
    setTimeout(() => setMovingId(null), 600);
    scrollToBlock(newBlocks[targetIndex].id);
  };

  const moveToTop = (index) => {
    if (index === 0) return;
    const newBlocks = [...blocks];
    const [item] = newBlocks.splice(index, 1);
    newBlocks.unshift(item);
    setBlocks(newBlocks);
    setMovingId(item.id);
    setTimeout(() => setMovingId(null), 600);
    scrollToBlock(item.id);
  };

  const moveToBottom = (index) => {
    if (index === blocks.length - 1) return;
    const newBlocks = [...blocks];
    const [item] = newBlocks.splice(index, 1);
    newBlocks.push(item);
    setBlocks(newBlocks);
    setMovingId(item.id);
    setTimeout(() => setMovingId(null), 600);
    scrollToBlock(item.id);
  };

  const reorderBlocks = (fromIndex, insertAt) => {
    if (fromIndex < 0 || insertAt < 0 || insertAt > blocks.length) return;
    if (fromIndex === insertAt || fromIndex + 1 === insertAt) return;
    const newBlocks = [...blocks];
    const [item] = newBlocks.splice(fromIndex, 1);
    let target = insertAt;
    if (fromIndex < insertAt) target -= 1;
    newBlocks.splice(target, 0, item);
    setBlocks(newBlocks);
    setMovingId(item.id);
    setTimeout(() => setMovingId(null), 600);
  };

  const handleMinimapDragStart = (e, index) => {
    if (e.target.closest('.block-minimap-del')) {
      e.preventDefault();
      return;
    }
    clearFileDrop();
    minimapDragMovedRef.current = false;
    setDragIndex(index);
    setDropIndex(null);
    setDropPosition(null);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    const row = e.currentTarget;
    if (row) e.dataTransfer.setDragImage(row, row.offsetWidth / 2, row.offsetHeight / 2);
  };

  const handleMinimapDragOver = (e, index) => {
    e.preventDefault();
    e.stopPropagation();
    if (compactMultiSelect) return;
    if (isFileDragEvent(e) && dragIndex === null) {
      const rect = e.currentTarget.getBoundingClientRect();
      const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      setFileDropIndex(index);
      setFileDropPosition(position);
      setFileDropEmpty(false);
      return;
    }
    if (dragIndex === null) return;
    minimapDragMovedRef.current = true;
    if (dragIndex === index) {
      setDropIndex(null);
      setDropPosition(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    setDropIndex(index);
    setDropPosition(position);
  };

  const handleMinimapContainerDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (compactMultiSelect) return;
    if (isFileDragEvent(e) && dragIndex === null) {
      if (!blocks.length) {
        setFileDropEmpty(true);
        setFileDropIndex(null);
        setFileDropPosition(null);
        return;
      }
      setFileDropIndex(blocks.length - 1);
      setFileDropPosition('after');
      setFileDropEmpty(false);
      return;
    }
    if (dragIndex === null || !blocks.length) return;
    minimapDragMovedRef.current = true;
    setDropIndex(blocks.length - 1);
    setDropPosition('after');
  };

  const handleMinimapDrop = (e, index) => {
    e.preventDefault();
    e.stopPropagation();
    const fileList = extractImageFilesFromDataTransfer(e.dataTransfer);
    if (fileList.length && dragIndex === null) {
      const rect = e.currentTarget.getBoundingClientRect();
      const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      const insertAt = position === 'after' ? index + 1 : index;
      handleFileDropAt(e, insertAt);
      return;
    }
    const from = dragIndex ?? parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (Number.isNaN(from)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    const insertAt = position === 'after' ? index + 1 : index;
    reorderBlocks(from, insertAt);
    setDragIndex(null);
    setDropIndex(null);
    setDropPosition(null);
  };

  const handleMinimapContainerDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const fileList = extractImageFilesFromDataTransfer(e.dataTransfer);
    if (fileList.length && dragIndex === null) {
      if (!blocks.length) {
        handleFileDropAt(e, 0);
      } else {
        handleFileDropAt(e, blocks.length);
      }
      return;
    }
    const from = dragIndex ?? parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (Number.isNaN(from)) return;
    reorderBlocks(from, blocks.length);
    setDragIndex(null);
    setDropIndex(null);
    setDropPosition(null);
  };

  const handleMinimapDragEnd = () => {
    setDragIndex(null);
    setDropIndex(null);
    setDropPosition(null);
    setTimeout(() => { minimapDragMovedRef.current = false; }, 0);
  };

  const handleMinimapClick = (blockId) => {
    if (minimapDragMovedRef.current) return;
    if (compactMultiSelect) {
      toggleCompactBlockSelect(blockId);
      return;
    }
    focusBlockInExpandedView(blockId);
  };

  const getBlockLabel = (type) => {
      if (type === 'h1') return 'H1 标题';
      if (type === 'lock') return '🔒 加密块';
      if (type === 'note') return '💬 注释块';
      if (type === 'image') return '🖼️ 图片块';
      if (type === 'quote') return '❝ 引用';
      if (type === 'link') return '🔗 超链文字';
      if (type === 'ol') return '🔢 有序列表';
      if (type === 'ul') return '• 无序列表';
      if (type === 'todo') return '☑️ 待办列表';
      if (type === 'toggle') return '▶ 折叠块';
      return '📄 内容块';
  };
  const linkModalValid = !!(linkModal && (linkModal.label || '').trim() && (linkModal.url || '').trim() && (linkModal.url || '').trim() !== 'https://');
  const lockModalBlock = lockModal ? blocks.find((b) => b.id === lockModal.blockId) : null;
  const lockModalIsDedicated = lockModalBlock?.type === 'lock';
  return (
    <div className="block-builder-shell" style={{marginTop:'30px'}}>
      {renderFloatingBlockTypeMenu()}
      {lockModal && (
        <div
          onMouseDown={(e) => { if (e.target === e.currentTarget) setLockModal(null); }}
          style={{ position:'fixed', inset:0, zIndex:10000, background:'rgba(0,0,0,0.55)', backdropFilter:'blur(2px)', display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}
        >
          <div style={{ width:'100%', maxWidth:'420px', background:'#1f1f24', border:'1px solid #3a3a42', borderRadius:'14px', boxShadow:'0 12px 40px rgba(0,0,0,0.5)', padding:'22px' }}>
            <div style={{ fontSize:'16px', fontWeight:'bold', color:'#fff', marginBottom:'4px', display:'flex', alignItems:'center', gap:'6px' }}>
              🔒 {lockModalIsDedicated ? '加密块密码' : (lockModal.isLocked ? '修改加密设置' : '内容加密')}
            </div>
            <div style={{ fontSize:'12px', color:'#999', marginBottom:'18px', lineHeight:1.6 }}>
              {lockModalIsDedicated
                ? '专用加密块始终受保护。密码留空则前台仅显示毛玻璃遮罩。'
                : '设置密码后前台需输入密码解锁；留空则仅毛玻璃遮罩，无需密码。'}
            </div>
            <label style={{ display:'block', fontSize:'12px', color:'#bbb', marginBottom:'6px' }}>访问密码（可选）</label>
            <input
              className="glow-input"
              autoFocus
              type="password"
              value={lockModal.pwd}
              onChange={(e) => setLockModal({ ...lockModal, pwd: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmLockModal(); if (e.key === 'Escape') setLockModal(null); }}
              placeholder="留空则无密码，仅毛玻璃遮罩"
              style={{ marginBottom:'22px', fontSize:'14px' }}
            />
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:'10px', flexWrap:'wrap' }}>
              <div>
                {!lockModalIsDedicated && lockModal.isLocked ? (
                  <button
                    type="button"
                    onClick={unlockBlockFromModal}
                    style={{ height:'36px', padding:'0 14px', borderRadius:'8px', cursor:'pointer', border:'1px solid #664', background:'transparent', color:'#fbbf24', fontSize:'13px' }}
                  >取消加密</button>
                ) : null}
              </div>
              <div style={{ display:'flex', gap:'10px' }}>
                <button
                  type="button"
                  onClick={() => setLockModal(null)}
                  style={{ height:'36px', padding:'0 16px', borderRadius:'8px', cursor:'pointer', border:'1px solid #444', background:'transparent', color:'#ccc', fontSize:'13px' }}
                >关闭</button>
                <button
                  type="button"
                  onClick={confirmLockModal}
                  style={{ height:'36px', padding:'0 18px', borderRadius:'8px', cursor:'pointer', border:'none', background:'#f59e0b', color:'#1a1200', fontSize:'13px', fontWeight:'bold' }}
                >{lockModal.isLocked && !lockModalIsDedicated ? '保存设置' : '确认加密'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {linkModal && (
        <div
          onMouseDown={(e) => { if (e.target === e.currentTarget) setLinkModal(null); }}
          style={{ position:'fixed', inset:0, zIndex:10000, background:'rgba(0,0,0,0.55)', backdropFilter:'blur(2px)', display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}
        >
          <div style={{ width:'100%', maxWidth:'420px', background:'#1f1f24', border:'1px solid #3a3a42', borderRadius:'14px', boxShadow:'0 12px 40px rgba(0,0,0,0.5)', padding:'22px' }}>
            <div style={{ fontSize:'16px', fontWeight:'bold', color:'#fff', marginBottom:'4px', display:'flex', alignItems:'center', gap:'6px' }}>🔗 添加超链接</div>
            <div style={{ fontSize:'12px', color:'#999', marginBottom:'18px' }}>将选中文字转为超链接；未选中时可手动填写显示文字。</div>
            <label style={{ display:'block', fontSize:'12px', color:'#bbb', marginBottom:'6px' }}>显示文字</label>
            <input
              className="glow-input"
              autoFocus
              value={linkModal.label}
              onChange={(e) => setLinkModal({ ...linkModal, label: e.target.value })}
              placeholder="例如：贩售机"
              style={{ marginBottom:'14px', fontSize:'14px' }}
            />
            <label style={{ display:'block', fontSize:'12px', color:'#bbb', marginBottom:'6px' }}>链接地址</label>
            <input
              className="glow-input"
              value={linkModal.url}
              onChange={(e) => setLinkModal({ ...linkModal, url: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter' && linkModalValid) confirmLinkModal(); if (e.key === 'Escape') setLinkModal(null); }}
              placeholder="https://..."
              style={{ marginBottom:'22px', fontSize:'14px', color:'#7cb3ff' }}
            />
            <div style={{ display:'flex', justifyContent:'flex-end', gap:'10px' }}>
              <button
                onClick={() => setLinkModal(null)}
                style={{ height:'36px', padding:'0 16px', borderRadius:'8px', cursor:'pointer', border:'1px solid #444', background:'transparent', color:'#ccc', fontSize:'13px' }}
              >取消</button>
              <button
                onClick={confirmLinkModal}
                disabled={!linkModalValid}
                style={{ height:'36px', padding:'0 18px', borderRadius:'8px', cursor: linkModalValid ? 'pointer' : 'not-allowed', border:'none', background: linkModalValid ? '#2f7cf6' : '#33384a', color: linkModalValid ? '#fff' : '#7a7f8c', fontSize:'13px', fontWeight:'bold' }}
              >确认</button>
            </div>
          </div>
        </div>
      )}
      <div className="block-builder-area-title">正文区域</div>
      <div className="block-add-toolbar">
          <div className="neo-btn" onClick={()=>addBlock('h1')}>正文标题</div>
          <div className="neo-btn" onClick={()=>addBlock('text')}>正文内容</div>
          <div className="neo-btn" onClick={()=>addBlock('image')}>正文图片</div>
          <div className="neo-btn" onClick={()=>addBlock('link')}>超链文字</div>
          <div className="neo-btn" onClick={()=>addBlock('quote')}>❝ 引用</div>
          <div className="neo-btn" onClick={()=>addBlock('note')}>💬 注释块</div>
          <div className="neo-btn" onClick={()=>addBlock('lock')}>🔒 加密块</div>
          <div className="neo-btn" onClick={()=>addBlock('ol')}>🔢 有序列表</div>
          <div className="neo-btn" onClick={()=>addBlock('ul')}>• 无序列表</div>
          <div className="neo-btn" onClick={()=>addBlock('todo')}>☑️ 待办列表</div>
          <div className="neo-btn" onClick={()=>addBlock('toggle')}>▶ 折叠块</div>
      </div>
      <div className="block-view-toolbar">
        <div className="block-view-toggle">
          <ViewModeButton
            label="放大视图"
            active={blockViewMode === 'expanded'}
            onClick={() => {
              exitCompactMultiSelect();
              setBlockViewMode('expanded');
            }}
          />
          <ViewModeButton
            label="缩小视图"
            active={blockViewMode === 'compact'}
            onClick={() => setBlockViewMode('compact')}
          />
        </div>
      </div>
      {blockViewMode === 'compact' ? (
        blocks.length === 0 ? (
          <div style={{ position: 'relative' }}>
            <div
              className={`block-empty-add${fileDropEmpty ? ' is-file-drop-target' : ''}`}
              onClick={(e) =>
                toggleAddMenu('empty-compact', e, (type) =>
                  addBlockAfter(-1, type, { stayCompact: true })
                )
              }
              onDragOver={handleEmptyFileDragOver}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) clearFileDrop();
              }}
              onDrop={(e) => {
                if (!isFileDragEvent(e)) return;
                handleFileDropAt(e, 0);
              }}
            >
              <span style={{ fontSize:'22px' }}>＋</span> 点击添加第一个内容块
            </div>
          </div>
        ) : (
          <div
            className={`block-minimap${fileDropEmpty ? ' is-file-drop-empty' : ''}`}
          >
            {renderCompactMinimapToolbar()}
            <div
              className="block-minimap-scroll"
              onDragOver={handleMinimapContainerDragOver}
              onDrop={handleMinimapContainerDrop}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) clearFileDrop();
              }}
            >
              <div className="block-minimap-list">
              {blocks.map((b, index) => (
                <React.Fragment key={b.id}>
                  <BlockMinimapItem
                    block={b}
                    index={index}
                    isCover={b.id === coverImageBlockId}
                    isDragging={dragIndex === index}
                    isDropBefore={!compactMultiSelect && isBlockDropBefore(index)}
                    isDropAfter={!compactMultiSelect && isBlockDropAfter(index)}
                    justMoved={movingId === b.id}
                    selectMode={compactMultiSelect}
                    isSelected={compactSelectedIds.includes(b.id)}
                    onDragStart={handleMinimapDragStart}
                    onDragOver={handleMinimapDragOver}
                    onDrop={handleMinimapDrop}
                    onDragEnd={handleMinimapDragEnd}
                    onClick={handleMinimapClick}
                    onRemove={removeBlock}
                  />
                  {renderMinimapAddBtn(`compact-after-${b.id}`, index)}
                </React.Fragment>
              ))}
            </div>
            </div>
          </div>
        )
      ) : (
      <div
        className="block-builder-expanded"
        onDragOver={(e) => {
          if (!isFileDragEvent(e) || !blocks.length) return;
          e.preventDefault();
          applyExpandedFileDropHighlight(e.currentTarget, e.clientY);
        }}
        onDrop={(e) => {
          const files = extractImageFilesFromDataTransfer(e.dataTransfer);
          if (!files.length || dragIndex !== null) return;
          e.preventDefault();
          e.stopPropagation();
          const { index, position } = resolveExpandedFileInsertFromY(e.currentTarget, e.clientY);
          const insertAt = position === 'after' ? index + 1 : index;
          handleFileDropAt(e, insertAt);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) clearFileDrop();
        }}
      >
        {blocks.map((b, index) => (
          <div
            key={b.id}
            className={`block-card-wrap${isBlockDropBefore(index) ? ' is-file-drop-before' : ''}${isBlockDropAfter(index) ? ' is-file-drop-after' : ''}`}
            onDragOver={(e) => handleExpandedFileDragOver(e, index)}
            onDrop={(e) => handleExpandedFileDrop(e, index)}
          >
          <div id={`block-${b.id}`} className={`block-card ${movingId === b.id ? 'just-moved' : ''}${isEditorBlockLocked(b) ? ' is-locked' : ''}`}>
            <div className="block-left-ctrl">
               <div className="move-btn" onClick={() => moveToTop(index)} title="置顶"><Icons.Top /></div>
               <div className="move-btn" onClick={() => moveBlock(index, -1)}><Icons.ArrowUp /></div>
               <div className="move-btn" onClick={() => moveBlock(index, 1)}><Icons.ArrowDown /></div>
               <div className="move-btn" onClick={() => moveToBottom(index)} title="置底"><Icons.Bottom /></div>
            </div>
            <div className="block-label-row">
              <div className="block-label">{getBlockLabel(b.type)}</div>
              <button
                type="button"
                className={`block-lock-btn${isEditorBlockLocked(b) ? ' is-active' : ''}`}
                title={isEditorBlockLocked(b) ? '已加密 · 点击修改密码或取消加密' : '加密此块（可选密码）'}
                onClick={() => openLockModal(b)}
                aria-label={isEditorBlockLocked(b) ? '修改加密设置' : '加密此块'}
              >
                {isEditorBlockLocked(b) ? '🔒' : '🔓'}
              </button>
            </div>
            {isEditorBlockLocked(b) && b.type !== 'lock' ? (
              <div className="block-lock-hint">
                🔒 已加密 · {getEditorBlockLockPwd(b) ? '前台需密码解锁' : '无密码'} · 正文仍可编辑
              </div>
            ) : null}
            {b.type !== 'image' && <FormatBar b={b} onChange={(key, val) => updateBlock(b.id, val, key)} onInsertLink={['text','h1','quote','note'].includes(b.type) ? () => insertLinkForBlock(b) : undefined} />}
            {b.type === 'h1' && <input id={'editfield-' + b.id} className="glow-input" placeholder="输入大标题..." value={b.content} onChange={e=>updateBlock(b.id, e.target.value)} style={{fontSize:'20px', ...fmtStyle(b), fontWeight:'bold'}} />}
            {b.type === 'text' && (
              <textarea
                id={'editfield-' + b.id}
                className="glow-input"
                placeholder="在此处输入正文，如需超链文字请选中文字后点击上方“链接”按钮"
                value={b.content}
                onChange={e=>updateBlock(b.id, e.target.value)}
                onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                onDrop={e => {
                  e.preventDefault();
                  e.stopPropagation();
                  const files = extractImageFilesFromDataTransfer(e.dataTransfer);
                  if (files.length) insertImageBlocksAfter(b.id, files);
                }}
                onPaste={e => {
                  const imgs = extractImageFilesFromClipboard(e.clipboardData);
                  if (imgs.length) {
                    e.preventDefault();
                    e.stopPropagation();
                    insertImageBlocksAfter(b.id, imgs);
                    return;
                  }
                  const conv = detectPastedBlockConversion(e.clipboardData ? e.clipboardData.getData('text/plain') : '');
                  if (!conv) return;
                  // H3: 自动分块仅对空块或全选状态生效，避免覆盖已有内容；其余情况走浏览器默认粘贴
                  const isBlockEmpty = !(b.content || '').trim();
                  const isSelectAll =
                    e.currentTarget.selectionStart === 0 &&
                    e.currentTarget.selectionEnd === e.currentTarget.value.length;
                  if (!isBlockEmpty && !isSelectAll) return;
                  e.preventDefault();
                  e.stopPropagation();
                  applyPastedBlockConversion(b.id, conv);
                }}
                style={{minHeight:'200px', ...fmtStyle(b)}}
              />
            )}
            {b.type === 'note' && <textarea id={'editfield-' + b.id} className="glow-input" placeholder="输入注释内容..." value={b.content} onChange={e=>updateBlock(b.id, e.target.value)} style={{minHeight:'80px', fontFamily: 'monospace', fontSize: '13px', ...fmtStyle(b), color: (b.color && b.color !== 'default') ? colorCss(b.color) : '#ff6b6b'}} />}
            {b.type === 'quote' && <textarea id={'editfield-' + b.id} className="glow-input" placeholder="输入引用内容..." value={b.content} onChange={e=>updateBlock(b.id, e.target.value)} style={{minHeight:'90px', borderLeft:'4px solid greenyellow', paddingLeft:'12px', ...fmtStyle(b)}} />}
            {b.type === 'ol' && (
              <div style={{width:'100%'}}>
                <div style={{fontSize:'12px', color:'#888', marginBottom:'6px', lineHeight:1.7, maxHeight:'96px', overflow:'auto', border:'1px dashed #444', borderRadius:'6px', padding:'6px 8px', background:'rgba(0,0,0,0.18)'}}>
                  {(b.content || '').split(/\r?\n/).some((l) => l.trim()) ? (b.content || '').split(/\r?\n/).map((line, i) => (
                    <div key={i}><span style={{color:'greenyellow', fontWeight:'bold'}}>{i+1}.</span> {line}</div>
                  )) : <span style={{color:'#666', fontStyle:'italic'}}>(空列表，每行输入一个列表项，保存后自动编号)</span>}
                </div>
                <textarea id={'editfield-' + b.id} className="glow-input" placeholder="每行一个列表项，自动按顺序编号" value={b.content} onChange={e=>updateBlock(b.id, e.target.value)} style={{minHeight:'120px', ...fmtStyle(b)}} />
              </div>
            )}
            {b.type === 'ul' && (
              <div style={{width:'100%'}}>
                <div style={{fontSize:'12px', color:'#888', marginBottom:'6px', lineHeight:1.7, maxHeight:'96px', overflow:'auto', border:'1px dashed #444', borderRadius:'6px', padding:'6px 8px', background:'rgba(0,0,0,0.18)'}}>
                  {(b.content || '').split(/\r?\n/).some((l) => l.trim()) ? (b.content || '').split(/\r?\n/).map((line, i) => (
                    <div key={i}><span style={{color:'greenyellow', fontWeight:'bold'}}>•</span> {line}</div>
                  )) : <span style={{color:'#666', fontStyle:'italic'}}>(空列表，每行输入一个列表项)</span>}
                </div>
                <textarea id={'editfield-' + b.id} className="glow-input" placeholder="每行一个列表项" value={b.content} onChange={e=>updateBlock(b.id, e.target.value)} style={{minHeight:'120px', ...fmtStyle(b)}} />
              </div>
            )}
            {b.type === 'todo' && (
              <div style={{width:'100%'}}>
                <div style={{fontSize:'12px', color:'#999', marginBottom:'6px'}}>每行一个待办项，勾选状态在保存后生效；行首可用 [x] / [ ] 前缀调整勾选</div>
                <div style={{fontSize:'12px', color:'#888', marginBottom:'6px', lineHeight:1.7, maxHeight:'96px', overflow:'auto', border:'1px dashed #444', borderRadius:'6px', padding:'6px 8px', background:'rgba(0,0,0,0.18)'}}>
                  {(b.content || '').split(/\r?\n/).some((l) => l.trim()) ? (b.content || '').split(/\r?\n/).map((line, i) => {
                    const m = line.match(/^\[([xX ])\]\s?/);
                    const checked = m ? m[1].toLowerCase() === 'x' : !!(b.checked && b.checked[i]);
                    const text = m ? line.slice(m[0].length) : line;
                    return (
                      <div key={i}>
                        <span
                          onClick={() => toggleTodoChecked(b.id, i)}
                          title="点击切换勾选"
                          style={{color:'greenyellow', fontWeight:'bold', cursor:'pointer', userSelect:'none'}}>{checked ? '☑' : '☐'}</span>{' '}
                        <span style={checked ? {textDecoration:'line-through', opacity:0.55} : undefined}>{text}</span>
                      </div>
                    );
                  }) : <span style={{color:'#666', fontStyle:'italic'}}>(空列表，每行输入一个待办项)</span>}
                </div>
                <textarea id={'editfield-' + b.id} className="glow-input" placeholder="每行一个待办项..." value={b.content} onChange={e=>updateBlock(b.id, e.target.value)} style={{minHeight:'120px', ...fmtStyle(b)}} />
              </div>
            )}
            {b.type === 'toggle' && (() => {
              const lines = Array.isArray(b.content) ? b.content : String(b.content || '').split(/\r?\n/);
              const open = !!toggleOpenMap[b.id];
              return (
                <div style={{width:'100%'}}>
                  <div style={{fontSize:'12px', color:'#888', marginBottom:'6px', lineHeight:1.7}}>第 1 行为折叠标题，其余每行为展开后的内容</div>
                  <div style={{marginBottom:'6px', border:'1px dashed #444', borderRadius:'6px', padding:'6px 10px', background:'rgba(0,0,0,0.18)', fontSize:'13px', color:'#ccc'}}>
                    <div
                      onClick={() => setToggleOpenMap(prev => ({ ...prev, [b.id]: !open }))}
                      style={{cursor:'pointer', display:'flex', alignItems:'center', gap:'6px', fontWeight:'bold'}}
                    >
                      <span style={{display:'inline-block', transition:'transform 0.2s', transform: open ? 'rotate(90deg)' : 'none', color:'greenyellow'}}>▶</span>
                      <span>{lines[0] || '（无标题）'}</span>
                    </div>
                    {open ? (
                      <div style={{marginTop:'6px', paddingLeft:'18px', lineHeight:1.7}}>
                        {lines.slice(1).some((l) => l.trim())
                          ? lines.slice(1).map((line, i) => (<div key={i}>{line || ' '}</div>))
                          : <span style={{color:'#666', fontStyle:'italic'}}>(无展开内容)</span>}
                      </div>
                    ) : null}
                  </div>
                  <textarea id={'editfield-' + b.id} className="glow-input" placeholder={'折叠标题\n展开内容行1\n展开内容行2'} value={lines.join('\n')} onChange={e=>updateBlock(b.id, e.target.value.split(/\r?\n/))} style={{minHeight:'100px', ...fmtStyle(b)}} />
                </div>
              );
            })()}
            {b.type === 'link' && (
               <div style={{display:'flex', flexDirection:'column', gap:'10px'}}>
                 <input className="glow-input" placeholder="显示文字（如：点此查看官网）" value={b.content} onChange={e=>updateBlock(b.id, e.target.value)} style={{...fmtStyle(b)}} />
                 <input className="glow-input" placeholder="链接地址 https://..." value={b.url || ''} onChange={e=>updateBlock(b.id, e.target.value, 'url')} style={{fontSize:'13px', color:'#7cb3ff'}} />
               </div>
            )}
            {b.type === 'lock' && (
               <div style={{background:'#202024', padding:'10px', borderRadius:'8px'}}>
                 <div style={{display:'flex', alignItems:'center', gap:'10px', marginBottom:'10px'}}><span>🔑</span><input className="glow-input" placeholder="留空则无密码" value={b.pwd} onChange={e=>updateBlock(b.id, e.target.value, 'pwd')} style={{width:'150px'}} /></div>
                 <textarea className="glow-input" placeholder="输入被加密的文本内容（可选）..." value={b.content} onChange={e=>updateBlock(b.id, e.target.value)} style={{minHeight:'140px', border:'1px dashed #555'}} />
                 {(b.images && b.images.length > 0) && (
                    <div style={{display:'flex', flexWrap:'wrap', gap:'8px', marginTop:'12px'}}>
                      {b.images.map((url, idx) => (
                         <div key={idx} style={{position:'relative', width:'72px', height:'72px', borderRadius:'6px', overflow:'hidden', border: isLockImagePending(b, url) ? '1px dashed #f59e0b' : '1px solid #444'}}>
                           <img src={url} style={{width:'100%', height:'100%', objectFit:'cover'}} alt="" />
                           {isLockImagePending(b, url) ? (
                             <span style={{position:'absolute', bottom:'2px', left:'2px', fontSize:'8px', color:'#fbbf24', background:'rgba(0,0,0,0.65)', padding:'1px 3px', borderRadius:'2px'}}>待发布</span>
                           ) : null}
                           <div onClick={()=>removeLockImage(b.id, idx)} style={{position:'absolute', top:'2px', right:'2px', background:'#ff4d4f', color:'#fff', width:'16px', height:'16px', borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'11px', cursor:'pointer', lineHeight:1}}>×</div>
                         </div>
                      ))}
                    </div>
                 )}
                 <label className="img-drop" style={{minHeight:'72px', marginTop:'12px', padding:'12px'}}
                   onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                   onDrop={e => { e.preventDefault(); e.stopPropagation(); assignPendingToLock(b.id, e.dataTransfer.files); }}>
                   <input type="file" accept="image/*" multiple style={{display:'none'}} onChange={e => { assignPendingToLock(b.id, e.target.files); e.target.value=''; }} />
                   <div style={{pointerEvents:'none', fontSize:'13px'}}>🔒 拖拽 / 点击 添加加密图片（本地预览，保存后上传）</div>
                 </label>
                 {b.error && <div className="img-err">⚠ {b.error}</div>}
               </div>
            )}
            {b.type === 'image' && (
               <label
                 className={`img-drop ${b.error ? 'err' : ''}`}
                 onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                 onDrop={e => { e.preventDefault(); e.stopPropagation(); handleFilesForBlock(b.id, e.dataTransfer.files); }}
               >
                 <input type="file" accept="image/*,video/*" multiple style={{display:'none'}} onChange={e => { handleFilesForBlock(b.id, e.target.files); e.target.value=''; }} />
                 {b.uploading ? (
                    <div className="img-uploading"><div className="img-spin"></div><div>上传中...</div></div>
                 ) : b.content ? (
                    <>
                      {isVideoImageContent(b.content)
                        ? <video src={b.content} controls className="img-preview" />
                        : <img src={b.content} className="img-preview" alt="" />}
                      {coverImageBlockId === b.id && !isVideoImageContent(b.content) ? (
                        <div style={{
                          fontSize: '12px',
                          fontWeight: 'bold',
                          color: '#000',
                          background: coverMode === COVER_MODE_BODY && b.isCover ? '#7dd3fc' : 'greenyellow',
                          padding: '6px 12px',
                          borderRadius: '6px',
                          marginTop: '8px',
                          textAlign: 'center',
                        }}>
                          {coverMode === COVER_MODE_BODY && b.isCover
                            ? '已手动设为封面'
                            : coverMode === COVER_MODE_AUTO
                              ? '当前图片将作为封面（自动）'
                              : '当前图片将作为封面'}
                        </div>
                      ) : null}
                      {!isVideoImageContent(b.content) && (coverMode === COVER_MODE_AUTO || coverMode === COVER_MODE_BODY) ? (
                        <div
                          style={{
                            display: 'flex',
                            gap: '8px',
                            marginTop: '10px',
                            justifyContent: 'center',
                            flexWrap: 'wrap',
                          }}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                        >
                          {coverMode === COVER_MODE_BODY && b.isCover ? (
                            <button
                              type="button"
                              className="neo-btn"
                              style={{ fontSize: '12px', padding: '6px 12px', opacity: 0.85 }}
                              onClick={onClearBodyCover}
                            >
                              取消封面设定
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="neo-btn"
                              style={{ fontSize: '12px', padding: '6px 12px' }}
                              onClick={() => onSetBodyCover(b.id)}
                            >
                              设为封面
                            </button>
                          )}
                        </div>
                      ) : null}
                      {isImageBlockPending(b) ? (
                        <div style={{fontSize:'11px', color:'#f59e0b', marginTop:'6px', fontWeight:'bold'}}>待发布</div>
                      ) : (
                        <div className="img-url">{b.content}</div>
                      )}
                      <div style={{fontSize:'11px', color:'greenyellow', marginTop:'6px'}}>点击 / 拖拽 以更换</div>
                    </>
                 ) : (
                    <div style={{pointerEvents:'none'}}>
                      <div style={{fontSize:'34px', marginBottom:'8px'}}>🖼️</div>
                      <div style={{fontWeight:'bold', color:'#ccc'}}>拖拽图片到此 · 点击选择 · 直接粘贴</div>
                      <div style={{fontSize:'12px', marginTop:'4px'}}>本地预览，保存/发布时自动压缩并上传</div>
                    </div>
                 )}
                 {b.error && <div className="img-err">⚠ {b.error}</div>}
               </label>
            )}
            <div className={`block-add-btn-wrap${addMenuFor === `expanded-after-${b.id}` ? ' is-open' : ''}`}>
              <div
                className={`block-add-btn ${addMenuFor === `expanded-after-${b.id}` ? 'open' : ''}`}
                title="在此块下方添加新块"
                onClick={(e) =>
                  toggleAddMenu(`expanded-after-${b.id}`, e, (type) =>
                    addBlockAfter(index, type)
                  )
                }
              ><span style={{ fontSize: '16px', lineHeight: 1 }}>＋</span> 添加块</div>
            </div>
            </div>
            <div className="block-del" onClick={()=>removeBlock(b.id)} title="删除此块"><Icons.Trash /></div>
          </div>
        ))}
        {blocks.length === 0 && (
          <div style={{ position:'relative' }}>
            <div
              className={`block-empty-add${fileDropEmpty ? ' is-file-drop-target' : ''}`}
              onClick={(e) =>
                toggleAddMenu('empty-expanded', e, (type) => addBlockAfter(-1, type))
              }
              onDragOver={handleEmptyFileDragOver}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) clearFileDrop();
              }}
              onDrop={(e) => {
                if (!isFileDragEvent(e)) return;
                handleFileDropAt(e, 0);
              }}
            >
              <span style={{ fontSize:'22px' }}>＋</span> 点击添加第一个内容块
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
};

const NOTION_COLOR_CSS = {
  default: '#e1e1e3', gray: '#9b9b9b', brown: '#b08968', orange: '#e9954e', yellow: '#d4b53d',
  green: '#4dab6d', blue: '#5b9bd5', purple: '#9a6dd7', pink: '#e255a1', red: '#ff6b6b',
};
const richStyle = (ann) => {
  const s = {};
  if (!ann) return s;
  if (ann.bold) s.fontWeight = 'bold';
  if (ann.italic) s.fontStyle = 'italic';
  const deco = [];
  if (ann.strikethrough) deco.push('line-through');
  if (ann.underline) deco.push('underline');
  if (deco.length) s.textDecoration = deco.join(' ');
  if (ann.color && ann.color !== 'default') {
    if (ann.color.endsWith('_background')) s.background = NOTION_COLOR_CSS[ann.color.replace('_background', '')] || 'transparent';
    else s.color = NOTION_COLOR_CSS[ann.color] || ann.color;
  }
  return s;
};
const RichText = ({ rich }) => (
  <>{(rich || []).map((r, j) => {
    const content = r.plain_text || r.text?.content || '';
    const url = r.text?.link?.url || r.href;
    const ann = r.annotations || {};
    const style = { ...richStyle(ann), ...(ann.code ? { fontFamily: 'monospace', background: '#333', padding: '1px 5px', borderRadius: '4px' } : {}) };
    if (url) return <a key={j} href={url} target="_blank" rel="noreferrer" style={{ ...style, color: style.color || '#7cb3ff', textDecoration: 'underline' }}>{content}</a>;
    return <span key={j} style={style}>{content}</span>;
  })}</>
);

const NotionView = ({ blocks }) => {
  if (!blocks || !Array.isArray(blocks)) return <div style={{padding:20, color:'#666'}}>暂无预览内容</div>;
  return (
    <div style={{color:'#e1e1e3', fontSize:'15px', lineHeight:'1.8'}}>
      {blocks.map((b, i) => {
        const type = b.type; const data = b[type]; const text = data?.rich_text?.[0]?.plain_text || "";
        if(type==='heading_1') return <h1 key={i} style={{fontSize:'1.8em', borderBottom:'1px solid #333', paddingBottom:'8px', margin:'24px 0 12px'}}><RichText rich={data?.rich_text} /></h1>;
        if(type==='heading_2') return <h2 key={i} style={{fontSize:'1.4em', margin:'20px 0 10px'}}><RichText rich={data?.rich_text} /></h2>;
        if(type==='heading_3') return <h3 key={i} style={{fontSize:'1.2em', margin:'18px 0 8px'}}><RichText rich={data?.rich_text} /></h3>;
        if(type==='paragraph') return <p key={i} style={{margin:'10px 0', minHeight:'1em'}}><RichText rich={data?.rich_text} /></p>;
        if(type==='quote') return <blockquote key={i} style={{margin:'16px 0', padding:'8px 0 8px 16px', borderLeft:'4px solid greenyellow', color:'#cfcfcf', fontStyle:'italic'}}><RichText rich={data?.rich_text} /></blockquote>;
        if(type==='divider') return <hr key={i} style={{border:'none', borderTop:'1px solid #444', margin:'24px 0'}} />;
        if(type==='image') { const url = data?.file?.url || data?.external?.url; if (!url) return null; const isVideo = url.match(/\.(mp4|mov|webm|ogg)(\?|$)/i); if(isVideo) return <div key={i} style={{display:'flex', justifyContent:'center', margin:'20px 0'}}><div style={{width:'100%', maxHeight:'500px', borderRadius:'8px', background:'#000', display:'flex', justifyContent:'center'}}><video src={url} controls preload="metadata" style={{maxWidth:'100%', maxHeight:'100%'}} /></div></div>; return <div key={i} style={{display:'flex', justifyContent:'center', margin:'20px 0'}}><div style={{width: '100%', height: '500px', background: '#000', borderRadius: '8px', display: 'flex', justifyContent: 'center', alignItems: 'center', overflow: 'hidden'}}><img src={url} style={{maxWidth: '100%', maxHeight: '100%', objectFit: 'contain'}} alt="" /></div></div>; }
        if(type==='video' || type==='embed') { let url = data?.file?.url || data?.external?.url || data?.url; if(!url) return null; const isY = url.includes('youtube')||url.includes('youtu.be'); if(isY){if(url.includes('watch?v='))url=url.replace('watch?v=','embed/');if(url.includes('youtu.be/'))url=url.replace('youtu.be/','www.youtube.com/embed/');} return <div key={i} style={{display:'flex', justifyContent:'center', margin:'20px 0'}}>{(type==='embed'||isY)?<iframe src={url} style={{width:'100%',maxWidth:'800px',height:'450px',border:'none',borderRadius:'8px',background:'#000'}} allowFullScreen />:<video src={url} controls style={{width:'100%',maxHeight:'500px',borderRadius:'8px',background:'#000'}}/>}</div>; }
        if(type==='callout') return <div key={i} style={{background:'#2d2d30', padding:'20px', borderRadius:'12px', border:'1px solid #3e3e42', display:'flex', gap:'15px', margin:'20px 0'}}><div style={{fontSize:'1.4em'}}>{b.callout.icon?.emoji || '🔒'}</div><div style={{flex:1}}><div style={{fontWeight:'bold', color:'greenyellow', marginBottom:'4px'}}>{text}</div><div style={{fontSize:'12px', opacity:0.5}}>[ 加密内容已受保护 ]</div></div></div>;
        return null;
      })}
    </div>
  );
};

// ==========================================
// 5. 主组件
// ==========================================
const ANNOUNCEMENT_SLUG = 'announcement';
const SIMPLE_CUSTOM_PAGE_SLUGS = new Set(['announcement', 'about', 'download']);

function isSimpleCustomPage(slug) {
  return SIMPLE_CUSTOM_PAGE_SLUGS.has(String(slug || '').trim());
}

export default function AdminDashboard() {
    // 🟢 1. 所有的 Hook (useState) 必须严格排在函数最顶部
const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [posts, setPosts] = useState([]);
  const [isThemeLoading, setIsThemeLoading] = useState(false);
  const [themeSwitchProgress, setThemeSwitchProgress] = useState(null);
  const [activeThemeLocal, setActiveThemeLocal] = useState(null);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [themeSwitchQuota, setThemeSwitchQuota] = useState({
    maxSwitches: 4,
    used: 0,
    remaining: 4,
    blocked: false,
    windowStart: null,
    windowEndsAt: null,
    remainingMs: 0,
  });

  const [view, setView] = useState('list');
  const [viewMode, setViewMode] = useState('covered');
  const [options, setOptions] = useState({ categories: [], tags: [] });
  const [activeTab, setActiveTab] = useState('Post');
  const [favouriteBusyId, setFavouriteBusyId] = useState(null);
  // P11-C2: 置顶连点防护（复刻 favouriteBusyId 的 busy-ref 模式）
  const [pinBusyId, setPinBusyId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAllTags, setShowAllTags] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [cardCatOpenId, setCardCatOpenId] = useState(null);
  const [cardCatMenuRect, setCardCatMenuRect] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [form, setForm] = useState({ title: '', slug: '', excerpt: '', content: '', category: '', tags: '', cover: '', status: 'Published', type: 'Post', date: '', download: '', download_size: '', download_count: '', article_password: '', linked_product_sku: '', linked_product_url: '', linked_product_price: '' });
  const [currentId, setCurrentId] = useState(null);
  const [siteTitle, setSiteTitle] = useState('PROBLOG');
  const [siteTitleEditing, setSiteTitleEditing] = useState(false);
  const [siteTitleDraft, setSiteTitleDraft] = useState('');
  const [siteTitleSaving, setSiteTitleSaving] = useState(false);
  const siteTitleEditingBaseRef = useRef('');
  const [navIdx, setNavIdx] = useState(1); 
  const [expandedStep, setExpandedStep] = useState(1);
  const [editorBlocks, setEditorBlocks] = useState([]);
  const editorBlocksRef = useRef(editorBlocks);
  editorBlocksRef.current = editorBlocks;
  const editingSlugRef = useRef(null);
  const editingCategoryRef = useRef(null);
  const editingTagsRef = useRef(null);
  // 记录进入编辑器时的文章状态（''=新建）：用于判断"草稿转首发"是否按首发处理
  const editingStatusRef = useRef('');

  // === Phase3: 未保存修改保护 + 本地草稿快照 ===
  // dirty 用 ref 镜像：beforeunload / routeChangeStart / popstate 回调里必须读 ref，避免闭包读到旧值
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  // 离开拦截三选一弹窗：放行动作（目标 url 或回调）暂存在 ref
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const pendingLeaveRef = useRef(null);
  const allowNavRef = useRef(false);
  // 发布方式：'Published' | 'Draft'（打开发布确认弹窗时重置）
  const [publishAs, setPublishAs] = useState('Published');
  // 草稿箱：本地快照 meta 列表
  const [draftSnapshots, setDraftSnapshots] = useState([]);
  // H2: 编辑器会话代号——每次进入编辑器/恢复快照 +1；发布任务入队时记录代号，
  // 成功回调只有代号仍一致（用户未重新进入编辑器）才允许清理 dirty / 本地快照
  const editorSessionRef = useRef(0);

  const markDirty = useCallback(() => {
    if (dirtyRef.current) return;
    dirtyRef.current = true;
    setDirty(true);
  }, []);

  const clearDirty = useCallback(() => {
    dirtyRef.current = false;
    setDirty(false);
  }, []);

  // 用户修改类 setForm / setBlocks 统一走包装入口；数据加载/重置仍直接用原 setter，绝不误标 dirty
  const setFormDirty = useCallback((next) => {
    markDirty();
    setForm(next);
  }, [markDirty]);

  const setEditorBlocksDirty = useCallback((next) => {
    markDirty();
    setEditorBlocks(next);
  }, [markDirty]);

  // P18-C4-5: Step7 商品信息只填商品码;链接/价格在发布时由 post.js 服务端
  // 查系统商品自动写入(查到=系统权威价覆盖,查不到=清空三字段并回执提示),
  // 表单里的 url/price 仅作只读展示,不再手填

  // P18C45FIX B2: Step7「添加商品信息」弹窗状态
  // result = { available, product: {sku,name,price,status}|null, error }
  // P18C45UI 批3:弹窗改单一主按钮时序(关联商品→查询中…→确认使用该商品),
  // 按钮与强调色统一蓝色(原粉红 #f472b6 已弃用)
  const [productLookup, setProductLookup] = useState({ open: false, sku: '', loading: false, result: null });
  const openProductLookupModal = () => {
    setProductLookup({ open: true, sku: String(form.linked_product_sku || '').trim(), loading: false, result: null });
  };
  // 当场查询:走服务端代理 /api/admin/merchant-product-lookup(主站 8s 超时),
  // 客户端 10s AbortController 仅作兜底;token 全程不出服务端
  const runProductLookupQuery = async () => {
    const sku = String(productLookup.sku || '').trim().toUpperCase();
    if (!sku) {
      setProductLookup((p) => ({ ...p, sku, result: { available: false, product: null, error: '请输入商品码' } }));
      return;
    }
    setProductLookup((p) => ({ ...p, sku, loading: true, result: null }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`/api/admin/merchant-product-lookup?sku=${encodeURIComponent(sku)}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.success) {
        setProductLookup((p) => ({ ...p, loading: false, result: { available: false, product: null, error: (data && data.error) || `查询失败(HTTP ${res.status})` } }));
        return;
      }
      setProductLookup((p) => ({ ...p, loading: false, result: { available: !!data.available, product: data.product || null, error: data.error || '' } }));
    } catch (err) {
      const timedOut = !!(err && err.name === 'AbortError');
      setProductLookup((p) => ({ ...p, loading: false, result: { available: false, product: null, error: timedOut ? '查询超时(8s),请稍后重试' : '网络异常,查询失败' } }));
    } finally {
      clearTimeout(timer);
    }
  };
  // 确认:写入表单商品码(优先系统返回的规范 sku);保存仍由 post.js 全量兜底再查一次
  const confirmProductLookup = () => {
    const result = productLookup.result;
    if (!result || !result.available || !result.product || !isShopLookupProductOnSale(result.product)) return;
    const sku = String(result.product.sku || productLookup.sku || '').trim();
    if (!sku) return;
    setFormDirty({ ...form, linked_product_sku: sku });
    setProductLookup((p) => ({ ...p, open: false }));
    showAdminToast(`商品码已写入：${sku}（保存时再次校验）`, 3000);
  };
  const productLookupConfirmable = !!(productLookup.result && productLookup.result.available && productLookup.result.product && isShopLookupProductOnSale(productLookup.result.product));
  // P18C45UI 批3:弹窗主按钮时序——未查到=「关联商品」(触发查询),
  // 查到在售=「确认使用该商品」(写入表单并关闭);loading 时不响应
  const runProductLookupPrimary = () => {
    if (productLookup.loading) return;
    if (productLookupConfirmable) { confirmProductLookup(); return; }
    runProductLookupQuery();
  };

  const [blogRefreshBusy, setBlogRefreshBusy] = useState(false);
  const [blogRefreshCooldownSec, setBlogRefreshCooldownSec] = useState(0);
  const blogRefreshCooldownUntilRef = useRef(0);
  const [crawlerIngestBusy, setCrawlerIngestBusy] = useState(false);
  const [crawlerIngestConfigured, setCrawlerIngestConfigured] = useState(false);
  const [crawlerIngestSummary, setCrawlerIngestSummary] = useState(null);
  const [crawlerIngestList, setCrawlerIngestList] = useState([]);
  const [crawlerIngestPendingList, setCrawlerIngestPendingList] = useState([]);
  const [crawlerIngestProcessingList, setCrawlerIngestProcessingList] = useState([]);
  const [crawlerIngestFailedList, setCrawlerIngestFailedList] = useState([]);
  const [crawlerIngestAutoSettings, setCrawlerIngestAutoSettings] = useState(null);
  const [crawlerIngestTab, setCrawlerIngestTab] = useState('pending');
  const [crawlerIngestSelectedIds, setCrawlerIngestSelectedIds] = useState([]);
  const [crawlerIngestProgress, setCrawlerIngestProgress] = useState(null);
  const crawlerIngestPollRef = useRef(null);
  const crawlerIngestCancelRef = useRef(false);
  const [listSelectMode, setListSelectMode] = useState(false);
  const [selectedPostIds, setSelectedPostIds] = useState([]);
  const [headerActionsMenuOpen, setHeaderActionsMenuOpen] = useState(false);
  const headerActionsMenuRef = useRef(null);
  const adminToastTimerRef = useRef(null);
  const [adminToast, setAdminToast] = useState({ message: '', visible: false, closing: false });
  const [tagDraft, setTagDraft] = useState('');
  const [showTagInput, setShowTagInput] = useState(false);
  const [catDraft, setCatDraft] = useState('');
  const [showCatInput, setShowCatInput] = useState(false);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [selectedPublishDate, setSelectedPublishDate] = useState(null);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [friends, setFriends] = useState([]);
  const [friendsLoading, setFriendsLoading] = useState(false);
  const [socialLinks, setSocialLinks] = useState({ enabled: false, links: [] });
  const [socialLinksLoading, setSocialLinksLoading] = useState(false);
  const [socialLinksSaving, setSocialLinksSaving] = useState(false);
  const [galleryAd, setGalleryAd] = useState({ id: null, enabled: false, url: '', promoText: '', cover: '' });
  const [galleryAdLoading, setGalleryAdLoading] = useState(false);
  const [galleryAdSaving, setGalleryAdSaving] = useState(false);
  const [galleryAdCoverUploading, setGalleryAdCoverUploading] = useState(false);
  const [galleryAdEditing, setGalleryAdEditing] = useState(false);
  const galleryAdSnapshotRef = useRef(null);
  // BLOG 分层 P4-FIX:站点会员计划(读取失败按免费版安全缺省);广告位为专业版权益
  const [sitePlan, setSitePlan] = useState(null); // null=尚未确认(loading),确认后为 'free' | 'pro'
  const adsLocked = sitePlan !== 'pro';
  // BLOG 分层 P8:贩售机组件为专业版权益(免费版灰态+点击弹提示;渲染仍按平台默认)
  const vendingLocked = sitePlan !== 'pro';
  // BLOG 分层 P8:去除平台角标开关(专业版权益;共用库 blog_quota_state.brand_clean)
  const [brandCleanEnabled, setBrandCleanEnabled] = useState(false);
  const [brandCleanLoading, setBrandCleanLoading] = useState(false);
  const [brandCleanSaving, setBrandCleanSaving] = useState(false);
  // P14:内容保护开关(全主题客户端防护;blog_site_settings.content_protect)
  const [contentProtectEnabled, setContentProtectEnabled] = useState(false);
  const [contentProtectLoading, setContentProtectLoading] = useState(false);
  const [contentProtectSaving, setContentProtectSaving] = useState(false);
  const [vendingEnabled, setVendingEnabled] = useState(true);
  const [vendingTitle, setVendingTitle] = useState('贩售机');
  const [vendingUrl, setVendingUrl] = useState('');
  const [vendingLoading, setVendingLoading] = useState(false);
  const [vendingSaving, setVendingSaving] = useState(false);
  const [vendingAddressUnlocked, setVendingAddressUnlocked] = useState(false);
  const [vendingAddressPassword, setVendingAddressPassword] = useState('');
  const [vendingEditing, setVendingEditing] = useState(false);
  const vendingSnapshotRef = useRef(null);
  const [announcementPopup, setAnnouncementPopup] = useState({
    id: null,
    enabled: false,
    title: '',
    content: '',
    image: '',
    buttonText: '',
    buttonUrl: '',
  });
  const [announcementPopupLoading, setAnnouncementPopupLoading] = useState(false);
  const [announcementPopupSaving, setAnnouncementPopupSaving] = useState(false);
  const [announcementPopupEditing, setAnnouncementPopupEditing] = useState(false);
  const announcementPopupSnapshotRef = useRef(null);
  const [popupAd, setPopupAd] = useState({
    id: null,
    enabled: false,
    title: '',
    content: '',
    image: '',
    buttonText: '',
    buttonUrl: '',
  });
  const [popupAdLoading, setPopupAdLoading] = useState(false);
  const [popupAdSaving, setPopupAdSaving] = useState(false);
  const [popupAdEditing, setPopupAdEditing] = useState(false);
  const popupAdSnapshotRef = useRef(null);
  const [clickAd, setClickAd] = useState({
    id: null,
    enabled: false,
    title: '',
    url: '',
  });
  const [clickAdLoading, setClickAdLoading] = useState(false);
  const [clickAdSaving, setClickAdSaving] = useState(false);
  const [clickAdEditing, setClickAdEditing] = useState(false);
  const clickAdSnapshotRef = useRef(null);
  // P18-C4-1: shop 主题首页 Banner(Notion Widget slug=banner;仅 shop 生效)
  const [shopBanner, setShopBanner] = useState({
    id: null,
    enabled: false,
    imagesText: '',
    link: '',
  });
  const [shopBannerLoading, setShopBannerLoading] = useState(false);
  const [shopBannerSaving, setShopBannerSaving] = useState(false);
  const [shopBannerEditing, setShopBannerEditing] = useState(false);
  const shopBannerSnapshotRef = useRef(null);
  // P18C43-D3: Banner 缩略图上传进度/失败提示 + 拖拽排序状态
  const [shopBannerUpload, setShopBannerUpload] = useState(null); // { done, total }
  const [shopBannerUploadError, setShopBannerUploadError] = useState('');
  const [shopBannerDragOver, setShopBannerDragOver] = useState(false);
  const [shopBannerDragIndex, setShopBannerDragIndex] = useState(null); // 缩略图排序拖拽源下标
  const shopBannerDragDepthRef = useRef(0);
  const [friendDraft, setFriendDraft] = useState({ name: '', url: '', avatar: '' });
  const [friendDraftUploading, setFriendDraftUploading] = useState(false);
  const [friendBtnStatus, setFriendBtnStatus] = useState({}); // { [id|'draft']: 'saving' | 'done' }
  const [coverUploading, setCoverUploading] = useState(false);
  const [galleryItems, setGalleryItems] = useState([]);
  const [galleryDirty, setGalleryDirty] = useState(false);
  const [coverSettings, setCoverSettings] = useState(createInitialCoverSettings);
  const [showManualCoverInput, setShowManualCoverInput] = useState(false);
  const [savePhase, setSavePhase] = useState(''); // '' | 'media' | 'post' | 'gallery' | 'delete'
  const [saveProgress, setSaveProgress] = useState(null); // { done, total }
  const [publishQueue, setPublishQueue] = useState([]); // 后台发布队列
  const [pendingPostSyncs, setPendingPostSyncs] = useState([]); // Notion 已创建、等待索引与前台刷新的新文章
  const queueRunningRef = useRef(false);
  // Phase4: 发布任务各阶段成功后的中间产物（blocks / galleryItems），失败时写入 job.resumeData 供断点续跑
  const jobProgressRef = useRef({});
  const cancelledJobsRef = useRef(new Set()); // 已请求取消的任务 id
  const pendingPostSyncsRef = useRef([]);
  const pendingPostSyncPollingRef = useRef(new Set());
  const pendingPostTypeOverridesRef = useRef(new Map());
  // P11-C4: fetchPosts 共享 in-flight Promise，并发调用复用同一次全量拉取
  const fetchPostsInflightRef = useRef(null);
  const [archivingPostIds, setArchivingPostIds] = useState([]);
  const [galleryStorageStats, setGalleryStorageStats] = useState(null);
  const [galleryStorageLoading, setGalleryStorageLoading] = useState(false);
  const [galleryStorageError, setGalleryStorageError] = useState('');
  const [coverModalOpen, setCoverModalOpen] = useState(false);
  const [coverModalClosing, setCoverModalClosing] = useState(false);
  const coverModalTimerRef = useRef(null);
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);
  const [publishConfirmClosing, setPublishConfirmClosing] = useState(false);
  const publishConfirmTimerRef = useRef(null);
  const [taxonomyConfirmOpen, setTaxonomyConfirmOpen] = useState(false);
  const [taxonomyConfirmClosing, setTaxonomyConfirmClosing] = useState(false);
  const [taxonomyConfirmName, setTaxonomyConfirmName] = useState('');
  const taxonomyConfirmTimerRef = useRef(null);
  const [crawlerIngestPassword, setCrawlerIngestPassword] = useState('');
  const [crawlerIngestUnlockOpen, setCrawlerIngestUnlockOpen] = useState(false);
  const [crawlerIngestUnlockClosing, setCrawlerIngestUnlockClosing] = useState(false);
  const [crawlerIngestUnlockBusy, setCrawlerIngestUnlockBusy] = useState(false);
  const [crawlerIngestUnlockError, setCrawlerIngestUnlockError] = useState('');
  const crawlerIngestUnlockTimerRef = useRef(null);
  const [vendingAddressUnlockOpen, setVendingAddressUnlockOpen] = useState(false);
  const [vendingAddressUnlockClosing, setVendingAddressUnlockClosing] = useState(false);
  const [vendingAddressUnlockBusy, setVendingAddressUnlockBusy] = useState(false);
  const [vendingAddressUnlockError, setVendingAddressUnlockError] = useState('');
  const vendingAddressUnlockTimerRef = useRef(null);
  const [themeDoneModalOpen, setThemeDoneModalOpen] = useState(false);
  const [themeDoneModalClosing, setThemeDoneModalClosing] = useState(false);
  const [themeDoneModalNote, setThemeDoneModalNote] = useState('');
  const themeDoneModalTimerRef = useRef(null);

  const resetGalleryItems = () => {
    setGalleryItems((prev) => {
      revokePendingGalleryItems(prev);
      return [];
    });
    setGalleryDirty(false);
  };

  const resetCoverSettings = () => {
    setCoverSettings(createInitialCoverSettings());
    setShowManualCoverInput(false);
  };

  const editorBodyCoverBlockId = useMemo(
    () => resolveEditorBodyCoverBlockId(editorBlocks, coverSettings.mode, galleryItems),
    [editorBlocks, coverSettings.mode, galleryItems]
  );

  const galleryCoverIndex = useMemo(
    () => resolveEditorGalleryCoverIndex(galleryItems, coverSettings.mode),
    [galleryItems, coverSettings.mode]
  );

  const coverStatusText = useMemo(
    () =>
      formatEditorCoverStatus({
        coverSettings,
        blocks: editorBlocks,
        galleryItems,
      }).full,
    [coverSettings, editorBlocks, galleryItems]
  );

  const handleToggleDefaultCover = (enabled) => {
    const applied = applyDefaultCoverToggle(enabled);
    setCoverSettings(applied.coverSettings);
    if (applied.clearBody) {
      setEditorBlocks((prev) => clearManualCoverFlags(prev));
    }
    if (applied.clearGallery) {
      setGalleryItems((prev) => clearGalleryCoverFlags(prev));
    }
    setShowManualCoverInput(false);
    markDirty();
  };

  const handleApplyManualCoverUrl = () => {
    const url = (coverSettings.manualUrl || '').trim();
    if (!url) {
      alert('请输入图片直链');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      alert('请输入以 http(s) 开头的有效链接');
      return;
    }
    const applied = applyManualCoverUrl(url);
    setCoverSettings(applied.coverSettings);
    if (applied.clearBody) {
      setEditorBlocks((prev) => clearManualCoverFlags(prev));
    }
    if (applied.clearGallery) {
      setGalleryItems((prev) => clearGalleryCoverFlags(prev));
    }
    markDirty();
  };

  const handleSetBodyCover = (blockId) => {
    const applied = applyBodyCoverSelection(editorBlocks, blockId);
    setCoverSettings(applied.coverSettings);
    setEditorBlocks(applied.blocks);
    if (applied.clearGallery) {
      setGalleryItems((prev) => clearGalleryCoverFlags(prev));
    }
    setShowManualCoverInput(false);
    markDirty();
  };

  const handleClearBodyCover = () => {
    const applied = clearBodyCoverSelection(editorBlocks, coverSettings.mode);
    setEditorBlocks(applied.blocks);
    if (applied.coverSettings) setCoverSettings(applied.coverSettings);
    markDirty();
  };

  const handleSetGalleryCover = (index) => {
    const applied = applyGalleryCoverSelection(galleryItems, index);
    setCoverSettings(applied.coverSettings);
    setGalleryItems(applied.galleryItems);
    if (applied.clearBody) {
      setEditorBlocks((prev) => clearManualCoverFlags(prev));
    }
    setShowManualCoverInput(false);
    setGalleryDirty(true);
    markDirty();
  };

  const handleClearGalleryCover = () => {
    const applied = clearGalleryCoverSelection(galleryItems, coverSettings.mode);
    setGalleryItems(applied.galleryItems);
    if (applied.coverSettings) setCoverSettings(applied.coverSettings);
    setGalleryDirty(true);
    markDirty();
  };

  const leaveEditView = () => {
    resetGalleryItems();
    resetCoverSettings();
    setEditorBlocks((prev) => {
      revokePendingEditorMedia(prev);
      return [];
    });
    setView('list');
  };

  const leaveRecycleView = () => {
    setListSelectMode(false);
    setSelectedPostIds([]);
    setView('list');
  };

  const openRecycleBin = () => {
    setListSelectMode(false);
    setSelectedPostIds([]);
    setSelectedFolder(null);
    setSelectedPublishDate(null);
    setDatePickerOpen(false);
    setView('recycle');
  };

  // 🟢 2. 增强表单校验逻辑：安全处理空值
  const isFormValid = (form?.type === 'Widget')
    ? (form?.title?.trim() || '') !== ''
    : isSimpleCustomPage(form?.slug) || form?.type === 'Page'
      ? ((form?.title?.trim() || '') !== '' && (form?.date || '') !== '')
      : ((form?.title?.trim() || '') !== '' &&
         (form?.category?.trim() || '') !== '' &&
         (form?.date || '') !== '');

  // 找出第一个未完成的必填项，用于灰色按钮被点击时的提示
  const getMissingFieldMsg = () => {
    if ((form?.title?.trim() || '') === '') return form?.type === 'Widget' ? '请填写组件标题' : '请填写文章标题';
    if (form?.type === 'Widget') return '';
    if (isSimpleCustomPage(form?.slug) || form?.type === 'Page') {
      if ((form?.date || '') === '') return '请选择发布日期';
      return '';
    }
    if ((form?.category?.trim() || '') === '') return '请填写文章分类';
    if ((form?.date || '') === '') return '请选择发布日期';
    return '';
  };
  // 统一的"尝试保存"：无效时弹出具体缺失项提示，有效时才真正保存
  const closeCoverModal = () => {
    if (coverModalTimerRef.current) clearTimeout(coverModalTimerRef.current);
    setCoverModalClosing(true);
    coverModalTimerRef.current = setTimeout(() => {
      setCoverModalOpen(false);
      setCoverModalClosing(false);
    }, 240);
  };

  const closePublishConfirmModal = () => {
    if (publishConfirmTimerRef.current) clearTimeout(publishConfirmTimerRef.current);
    setPublishConfirmClosing(true);
    publishConfirmTimerRef.current = setTimeout(() => {
      setPublishConfirmOpen(false);
      setPublishConfirmClosing(false);
    }, 240);
  };

  const closeTaxonomyConfirmModal = () => {
    if (taxonomyConfirmTimerRef.current) clearTimeout(taxonomyConfirmTimerRef.current);
    setTaxonomyConfirmClosing(true);
    taxonomyConfirmTimerRef.current = setTimeout(() => {
      setTaxonomyConfirmOpen(false);
      setTaxonomyConfirmClosing(false);
      setTaxonomyConfirmName('');
    }, 240);
  };

  const confirmTaxonomyDelete = () => {
    const name = taxonomyConfirmName;
    closeTaxonomyConfirmModal();
    setTimeout(() => permanentlyDeleteCategory(name), 260);
  };

  const closeCrawlerIngestUnlockModal = () => {
    if (crawlerIngestUnlockTimerRef.current) clearTimeout(crawlerIngestUnlockTimerRef.current);
    setCrawlerIngestUnlockError('');
    setCrawlerIngestUnlockClosing(true);
    crawlerIngestUnlockTimerRef.current = setTimeout(() => {
      setCrawlerIngestUnlockOpen(false);
      setCrawlerIngestUnlockClosing(false);
    }, 240);
  };

  const closeVendingAddressUnlockModal = () => {
    if (vendingAddressUnlockTimerRef.current) clearTimeout(vendingAddressUnlockTimerRef.current);
    setVendingAddressUnlockError('');
    setVendingAddressUnlockClosing(true);
    vendingAddressUnlockTimerRef.current = setTimeout(() => {
      setVendingAddressUnlockOpen(false);
      setVendingAddressUnlockClosing(false);
    }, 240);
  };

  const formIsPostArticle =
    form?.type !== 'Widget' &&
    form?.type !== 'Page' &&
    !isSimpleCustomPage(form?.slug) &&
    (form?.type === 'Post' || !form?.type);

  const proceedPublishAfterConfirm = () => {
    closePublishConfirmModal();
    setTimeout(() => {
      if (
        formIsPostArticle &&
        !hasEditorImageBlock(editorBlocksRef.current || []) &&
        !hasGalleryImageItem(galleryItems)
      ) {
        setCoverModalClosing(false);
        setCoverModalOpen(true);
        return;
      }
      enqueuePublish();
    }, 260);
  };

  const openThemeDoneModal = (extraNote = '') => {
    if (themeDoneModalTimerRef.current) clearTimeout(themeDoneModalTimerRef.current);
    setThemeDoneModalNote(extraNote);
    setThemeDoneModalClosing(false);
    setThemeDoneModalOpen(true);
  };

  const closeThemeDoneModal = () => {
    if (themeDoneModalTimerRef.current) clearTimeout(themeDoneModalTimerRef.current);
    setThemeDoneModalClosing(true);
    themeDoneModalTimerRef.current = setTimeout(() => {
      setThemeDoneModalOpen(false);
      setThemeDoneModalClosing(false);
      setThemeDoneModalNote('');
    }, 240);
  };

  const showAdminToast = (message, durationMs = 2800) => {
    if (adminToastTimerRef.current) clearTimeout(adminToastTimerRef.current);
    setAdminToast({ message, visible: true, closing: false });
    adminToastTimerRef.current = setTimeout(() => {
      setAdminToast((prev) => ({ ...prev, closing: true }));
      adminToastTimerRef.current = setTimeout(() => {
        setAdminToast({ message: '', visible: false, closing: false });
      }, 280);
    }, durationMs);
  };

  // === Phase3: 草稿快照 ===
  // 把当前编辑器内容写入 localStorage（pending 本地图片无法序列化，保存时自动剔除）
  const saveDraftSnapshot = useCallback(() => {
    const snap = {
      // M1: 传原始 blocks / galleryItems，由 saveEditorDraftSnapshot 内部统一净化并统计 droppedMediaCount
      // （预先净化会让未上传媒体数恒为 0，恢复后无法提示补图）
      blocks: editorBlocksRef.current || [],
      form: { ...form },
      galleryItems,
      cover: form?.cover || '',
      coverSettings: { ...coverSettings },
      updatedAt: new Date().toISOString(),
      postId: currentId || null,
      slug: form?.slug || '',
    };
    const ok = !!saveEditorDraftSnapshot(snap, {
      kind: 'manual',
      title: (form?.title || '').trim() || '未命名',
      postId: currentId || null,
      slug: form?.slug || '',
    });
    return ok;
  }, [form, galleryItems, coverSettings, currentId]);

  const handleSaveDraftClick = useCallback(() => {
    const ok = saveDraftSnapshot();
    if (ok) showAdminToast('💾 已保存本地草稿（可在下次进入编辑器时恢复）', 2600);
    else alert('本地草稿保存失败（浏览器存储不可用或容量已满）');
  }, [saveDraftSnapshot]);

  // Phase4: 统一的「恢复快照到编辑器」——草稿箱恢复 / 失败任务恢复到编辑器共用
  const restoreSnapshotToEditor = useCallback((snap) => {
    if (!snap) return false;
    // H2: 每次恢复快照都进入新的编辑器会话，旧发布任务成功回调不再误清当前编辑器状态
    editorSessionRef.current += 1;
    editingStatusRef.current = (snap.form && snap.form.status) || '';
    if (!snap.postId) {
      // H1: 新文章快照必须清空残留的 currentId / refs，否则发布会误更新上次编辑的文章
      setCurrentId(null);
      editingSlugRef.current = null;
      editingCategoryRef.current = null;
      editingTagsRef.current = null;
    }
    setForm(snap.form || {});
    setEditorBlocks(Array.isArray(snap.blocks) ? snap.blocks : []);
    setGalleryItems(Array.isArray(snap.galleryItems) ? snap.galleryItems : []);
    if (snap.coverSettings && typeof snap.coverSettings === 'object') {
      setCoverSettings({ ...createInitialCoverSettings(), ...snap.coverSettings });
      setShowManualCoverInput(snap.coverSettings.mode === COVER_MODE_URL);
    }
    if (snap.postId) {
      setCurrentId(snap.postId);
      editingSlugRef.current = snap.slug || null;
      editingCategoryRef.current = snap.form?.category || null;
      editingTagsRef.current = snap.form?.tags || null;
    }
    setGalleryDirty(false);
    markDirty();
    if (snap && snap.droppedMediaCount > 0) {
      const droppedCount = snap.droppedMediaCount;
      // 调用方恢复成功后会立刻弹标准 toast（单槽位会顶掉本条），延后到其后展示
      setTimeout(() => {
        showAdminToast(
          `该草稿有 ${droppedCount} 个未上传的图片，恢复后需重新添加`,
          4200
        );
      }, 3500);
    }
    return true;
  }, [markDirty]);

  // 保存/发布成功后，清理该文章（postId 或 slug）的全部本地快照
  const maybeClearSnapshotAfterSave = useCallback((payload) => {
    clearEditorDraftSnapshotsForPost(payload.currentId || (payload.form?.slug || ''));
  }, []);

  // === Phase3: 离开拦截（三选一弹窗） ===
  const closeLeaveConfirm = () => {
    pendingLeaveRef.current = null;
    setLeaveConfirmOpen(false);
  };

  const executePendingLeave = useCallback(() => {
    const pending = pendingLeaveRef.current;
    pendingLeaveRef.current = null;
    setLeaveConfirmOpen(false);
    clearDirty();
    if (!pending) return;
    if (pending.type === 'url') {
      allowNavRef.current = true;
      router.push(pending.url);
    } else if (typeof pending.action === 'function') {
      pending.action();
    }
  }, [router, clearDirty]);

  const leaveConfirmLeaveAnyway = () => executePendingLeave();

  const leaveConfirmSaveDraft = () => {
    const ok = saveDraftSnapshot();
    if (!ok) {
      alert('本地草稿保存失败（浏览器存储不可用或容量已满），已留在编辑器');
      closeLeaveConfirm();
      return;
    }
    executePendingLeave();
    showAdminToast('💾 已保存到草稿', 2600);
  };

  // 编辑视图内离开（返回列表等）：dirty 时先弹三选一
  const guardLeaveEditor = (action) => {
    if (!dirtyRef.current) {
      action();
      return;
    }
    pendingLeaveRef.current = { type: 'action', action };
    setLeaveConfirmOpen(true);
  };

  // 浏览器刷新/关闭：原生 beforeunload 提示（浏览器不允许自定义文案）
  useEffect(() => {
    const handler = (e) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // next/router 路由级导航拦截：dirty 时中止导航并弹三选一；
  // 放行时置 allowNavRef 跳过下一次拦截，避免死循环；同路径 hash 变化不拦截
  useEffect(() => {
    if (!router) return undefined;
    const handleRouteChangeStart = (url) => {
      if (!dirtyRef.current) return;
      if (allowNavRef.current) {
        allowNavRef.current = false;
        return;
      }
      const current = router.asPath || window.location.pathname;
      if (typeof url === 'string' && url.split('#')[0] === String(current).split('#')[0]) return;
      pendingLeaveRef.current = { type: 'url', url };
      setLeaveConfirmOpen(true);
      throw new Error('EDITOR_UNSAVED_CHANGES');
    };
    const resetAllowNav = () => {
      allowNavRef.current = false;
    };
    router.events.on('routeChangeStart', handleRouteChangeStart);
    router.events.on('routeChangeComplete', resetAllowNav);
    return () => {
      router.events.off('routeChangeStart', handleRouteChangeStart);
      router.events.off('routeChangeComplete', resetAllowNav);
    };
  }, [router]);

  // === Phase4: 草稿箱 ===
  const refreshDraftSnapshots = useCallback(() => {
    setDraftSnapshots(listEditorDraftSnapshots());
  }, []);

  const openDraftsView = useCallback(() => {
    refreshDraftSnapshots();
    setView('drafts');
  }, [refreshDraftSnapshots]);

  // 草稿箱「恢复编辑」：回填编辑器 + markDirty；保留原快照（成功保存后才由 maybeClearSnapshotAfterSave 清理）
  const restoreDraftFromBox = useCallback((id) => {
    const snap = loadEditorDraftSnapshot(id);
    if (!snap) {
      showAdminToast('本地草稿已不存在或已损坏');
      refreshDraftSnapshots();
      return;
    }
    if (!restoreSnapshotToEditor(snap)) return;
    setView('edit');
    setExpandedStep(0);
    showAdminToast('已恢复本地草稿，请及时保存', 3200);
  }, [restoreSnapshotToEditor, refreshDraftSnapshots]);

  const deleteDraftSnapshot = useCallback((id) => {
    removeEditorDraftSnapshot(id);
    refreshDraftSnapshots();
    showAdminToast('已删除该本地草稿', 2000);
  }, [refreshDraftSnapshots]);

  // 刷新后提示：上次会话中可能有未完成的发布任务
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(PUBLISH_QUEUE_META_KEY);
      if (!raw) return;
      const meta = JSON.parse(raw);
      if (!Array.isArray(meta)) return;
      const unfinished = meta.filter(
        (j) => j.status === 'queued' || j.status === 'running'
      );
      if (unfinished.length > 0) {
        showAdminToast(
          `检测到 ${unfinished.length} 个发布任务可能未完成，请核对内容列表后决定是否重新发布`
        );
      }
    } catch {
      // ignore
    } finally {
      sessionStorage.removeItem(PUBLISH_QUEUE_META_KEY);
    }
  }, []);

  useEffect(() => {
    if (!publishQueue.length) {
      sessionStorage.removeItem(PUBLISH_QUEUE_META_KEY);
      return;
    }
    try {
      sessionStorage.setItem(
        PUBLISH_QUEUE_META_KEY,
        JSON.stringify(
          publishQueue.map((j) => ({
            id: j.id,
            title: j.title,
            status: j.status,
            phase: j.phase,
            startedAt: j.startedAt,
          }))
        )
      );
    } catch {
      // ignore quota / private mode
    }
  }, [publishQueue]);

  const attemptSave = () => {
    const msg = getMissingFieldMsg();
    if (msg) { alert('⚠️ ' + msg); return; }
    setPublishAs('Published');
    setPublishConfirmClosing(false);
    setPublishConfirmOpen(true);
  };

  const confirmCoverAndSave = () => {
    closeCoverModal();
    setTimeout(() => enqueuePublish(), 260);
  };

  // 🟢 3. 主题状态计算
  const themeConfig = posts?.find(p => p.slug === 'theme-config');
  const currentActiveTheme = activeThemeLocal || themeConfig?.excerpt?.trim() || 'v1';
  const currentTheme = ADMIN_THEMES.find(t => t.id === currentActiveTheme) || ADMIN_THEMES[0];

  async function loadGalleryStorage() {
    setGalleryStorageLoading(true);
    setGalleryStorageError('');
    try {
      const r = await fetch('/api/admin/gallery-storage');
      const d = await r.json();
      if (!d.success) throw new Error(d.error || '读取图库容量失败');
      setGalleryStorageStats(d);
    } catch (e) {
      setGalleryStorageStats(null);
      setGalleryStorageError(e.message);
    } finally {
      setGalleryStorageLoading(false);
    }
  }

  // BLOG 分层 P4-FIX:读取站点会员计划(只读;失败保持 free,广告位灰态安全缺省)
  const loadSitePlan = async () => {
    try {
      const r = await fetch('/api/admin/site-plan');
      const d = await r.json();
      if (d && d.success && d.plan) setSitePlan(d.plan === 'pro' ? 'pro' : 'free');
    } catch {
      // 忽略:按免费版处理
    }
  };

  // 🟢 4. 数据拉取函数 (提前定义)
  async function fetchPosts({ silent = false } = {}) {
    // P11-C4: 已有 in-flight 请求则复用，避免并发重复全量拉取
    if (fetchPostsInflightRef.current) return fetchPostsInflightRef.current;
    const run = (async () => {
    if (!silent) setLoading(true);
    try { 
       const r = await fetch('/api/admin/posts');
       if (!r.ok) throw new Error(`API Error: ${r.status}`);
       const d = await r.json(); 
       if (d.success) { 
          const remotePosts = d.posts || [];
          setPosts((previousPosts) => {
            const synchronizedRemotePosts = remotePosts.map((post) => {
              const expectedType = pendingPostTypeOverridesRef.current.get(post.id);
              if (!expectedType) return post;
              if (post.type === expectedType) {
                pendingPostTypeOverridesRef.current.delete(post.id);
                return post;
              }
              return { ...post, type: expectedType };
            });
            const remoteIds = new Set(synchronizedRemotePosts.map((post) => post.id));
            const pendingIds = new Set(pendingPostSyncsRef.current.map((item) => item.id));
            const optimisticPosts = previousPosts.filter(
              (post) =>
                (pendingIds.has(post.id) || pendingPostTypeOverridesRef.current.has(post.id)) &&
                !remoteIds.has(post.id)
            ).map((post) =>
              pendingPostTypeOverridesRef.current.has(post.id)
                ? { ...post, type: pendingPostTypeOverridesRef.current.get(post.id) }
                : post
            );
            return [...optimisticPosts, ...synchronizedRemotePosts];
          });
          setOptions(d.options || { categories: [], tags: [] });
          const remote = d.posts.find(p => p.slug === 'theme-config')?.excerpt?.trim();
          if (remote) setActiveThemeLocal(remote);
        }
        const rConf = await fetch('/api/admin/config');
        if (rConf.ok) {
            const dConf = await rConf.json(); 
            if (dConf.success && dConf.siteInfo) setSiteTitle(dConf.siteInfo.title);
        }
     } catch(e) { console.warn(e); } 
     finally { if (!silent) setLoading(false); } 
    })();
    fetchPostsInflightRef.current = run;
    try {
      return await run;
    } finally {
      if (fetchPostsInflightRef.current === run) fetchPostsInflightRef.current = null;
    }
  }

  const registerPendingPostSync = useCallback((item) => {
    const next = [
      item,
      ...pendingPostSyncsRef.current.filter((current) => current.id !== item.id),
    ];
    pendingPostSyncsRef.current = next;
    setPendingPostSyncs(next);
  }, []);

  useEffect(() => {
    if (!mounted || pendingPostSyncs.length === 0) return;
    let stopped = false;

    const pollPendingPostSyncs = async () => {
      const completedIds = [];
      for (const item of pendingPostSyncsRef.current) {
        if (stopped || pendingPostSyncPollingRef.current.has(item.id)) continue;
        pendingPostSyncPollingRef.current.add(item.id);
        try {
          const check = await fetch(
            `/api/admin/posts?syncSlug=${encodeURIComponent(item.slug)}&syncId=${encodeURIComponent(item.id)}`,
            { cache: 'no-store' }
          );
          const checkData = await check.json().catch(() => null);
          if (!check.ok || !checkData?.indexed) continue;

          const rev = await triggerContentRevalidation({
            scope: 'post',
            slug: item.slug,
            category: item.category || '',
            tags: item.tags || '',
            clearCaches: true,
            warmPaths: true,
            contentChange: true,
          });
          if (rev.ok) {
            completedIds.push(item.id);
            showAdminToast(`新文章「${item.title}」已同步到前台`);
          }
        } catch (error) {
          console.warn('新文章同步状态检查失败', error);
        } finally {
          pendingPostSyncPollingRef.current.delete(item.id);
        }
      }

      if (!stopped && completedIds.length > 0) {
        const completed = new Set(completedIds);
        const next = pendingPostSyncsRef.current.filter((item) => !completed.has(item.id));
        pendingPostSyncsRef.current = next;
        setPendingPostSyncs(next);
        fetchPosts({ silent: true });
      }
    };

    const initialTimer = setTimeout(pollPendingPostSyncs, 4000);
    const intervalTimer = setInterval(pollPendingPostSyncs, 15000);
    return () => {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    };
  }, [mounted, pendingPostSyncs.length]);

  // 🟢 5. 处理函数
  const loadThemeSwitchQuota = async () => {
    try {
      const r = await fetch('/api/admin/theme-cooldown');
      const d = await r.json();
      if (d.success && d.quota) {
        setThemeSwitchQuota(d.quota);
      }
    } catch (e) {
      console.warn('读取主题切换配额失败', e);
    }
  };

  const handleThemeChange = async (version) => {
    if (isThemeLoading || loading || version === currentActiveTheme) return;
    if (themeSwitchQuota.blocked) {
      alert(formatThemeSwitchQuotaRemaining(themeSwitchQuota.remainingMs) || '24 小时内主题切换已达上限');
      return;
    }
    const configItem = themeConfig || posts.find(p => p.slug === 'theme-config');
    if (!configItem) { alert("未找到配置页"); return; }
    const previousTheme = currentActiveTheme;
    setThemeMenuOpen(false);
    setIsThemeLoading(true);
    setThemeSwitchProgress({
      step: 1,
      totalSteps: 3,
      label: '正在保存主题设置…',
      done: 0,
      total: 0,
      hint: `切换至 ${ADMIN_THEMES.find(t => t.id === version)?.label || version}`,
    });
    setActiveThemeLocal(version);
    try {
      const payload = { id: configItem.id, title: configItem.title || '主题配置', slug: 'theme-config', excerpt: version };
      const res = await fetch('/api/admin/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const resData = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 429 && resData.code === 'THEME_SWITCH_QUOTA_EXCEEDED') {
          setThemeSwitchQuota((prev) => ({
            ...prev,
            blocked: true,
            remaining: 0,
            windowEndsAt: resData.windowEndsAt || prev.windowEndsAt,
            remainingMs: resData.remainingMs || 0,
          }));
          throw new Error(resData.error || '24 小时内主题切换已达上限');
        }
        throw new Error(resData.error || '保存主题配置失败');
      }

      let confirmed = false;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((r) => setTimeout(r, attempt === 0 ? 800 : 1200));
        try {
          const checkRes = await fetch('/api/admin/posts');
          if (checkRes.ok) {
            const checkData = await checkRes.json();
            const remote = checkData.posts?.find((p) => p.slug === 'theme-config')?.excerpt?.trim();
            if (remote === version) {
              confirmed = true;
              break;
            }
          }
        } catch {
          /* 下一轮重试 */
        }
      }
      if (!confirmed) {
        console.warn('[handleThemeChange] theme-config read-back not confirmed, revalidating anyway');
      }

      const refreshResult = await runThemeRevalidation(setThemeSwitchProgress, version);
      await fetchPosts();
      void loadThemeSwitchQuota();

      openThemeDoneModal(
        refreshResult.failed > 0
          ? `另有 ${refreshResult.failed} 个列表页未能及时更新，不影响已保存的主题设置；内页仍会在访问后或 1 小时内自动切换。`
          : ''
      );
    } catch (err) {
      setActiveThemeLocal(previousTheme);
      alert('切换失败：' + (err.message || '未知错误'));
    } finally {
      setIsThemeLoading(false);
      setThemeSwitchProgress(null);
    }
  };

  // 🟢 6. useEffect 挂载
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    if (!mounted) return;
    void loadThemeSwitchQuota();
  }, [mounted]);
  useEffect(() => {
    if (!themeMenuOpen) return;
    void loadThemeSwitchQuota();
  }, [themeMenuOpen]);
  useEffect(() => {
    const tick = () => {
      const left = Math.ceil((blogRefreshCooldownUntilRef.current - Date.now()) / 1000);
      setBlogRefreshCooldownSec(left > 0 ? left : 0);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!headerActionsMenuOpen) return;
    const onPointerDown = (e) => {
      if (
        headerActionsMenuRef.current &&
        !headerActionsMenuRef.current.contains(e.target)
      ) {
        setHeaderActionsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [headerActionsMenuOpen]);
  const buildCrawlerIngestHeaders = (extra = {}, passwordOverride = crawlerIngestPassword) => ({
    ...extra,
    ...(passwordOverride
      ? { 'x-admin-maintenance-password': passwordOverride }
      : {}),
  });

  const handleCrawlerIngestAuthError = (message = '爬虫管理密码错误') => {
    setCrawlerIngestPassword('');
    setCrawlerIngestUnlockError(message);
    setCrawlerIngestUnlockClosing(false);
    setCrawlerIngestUnlockOpen(true);
  };

  const fetchCrawlerIngestStatus = async () => {
    try {
      const res = await fetch('/api/admin/crawler-ingest?summary=1');
      const data = await res.json();
      if (!res.ok || !data.success) return null;
      applyCrawlerIngestPayload(data);
      return data;
    } catch (e) {
      console.warn('读取爬虫队列状态失败', e);
      return null;
    }
  };

  const applyCrawlerIngestPayload = (data) => {
    if (!data) return;
    setCrawlerIngestConfigured(Boolean(data.configured));
    if (data.summary) setCrawlerIngestSummary(data.summary);
    if (data.pendingItems) setCrawlerIngestPendingList(data.pendingItems);
    if (data.processingItems) setCrawlerIngestProcessingList(data.processingItems);
    if (data.failedItems) setCrawlerIngestFailedList(data.failedItems);
    if (data.items) setCrawlerIngestList(data.items);
    if (data.autoSettings) setCrawlerIngestAutoSettings(data.autoSettings);
  };

  const fetchCrawlerIngestTab = async (tab = crawlerIngestTab, passwordOverride = crawlerIngestPassword) => {
    try {
      const res = await fetch(`/api/admin/crawler-ingest?tab=${encodeURIComponent(tab)}`, {
        headers: buildCrawlerIngestHeaders({}, passwordOverride),
      });
      const data = await res.json();
      if (res.status === 403) {
        handleCrawlerIngestAuthError(data.error || '爬虫管理密码错误');
        return null;
      }
      if (!res.ok || !data.success) return null;
      applyCrawlerIngestPayload(data);
      return data;
    } catch (e) {
      console.warn('读取爬虫队列失败', e);
      return null;
    }
  };

  const fetchCrawlerPendingList = async () => fetchCrawlerIngestTab('pending');

  const refreshCrawlerIngestPanel = async (tab = crawlerIngestTab) => {
    await fetchCrawlerIngestTab(tab);
  };

  const openCrawlerIngestView = async () => {
    if (!crawlerIngestPassword) {
      setCrawlerIngestUnlockError('');
      setCrawlerIngestUnlockClosing(false);
      setCrawlerIngestUnlockOpen(true);
      return;
    }
    setView('crawler-ingest');
    setCrawlerIngestTab('pending');
    setCrawlerIngestSelectedIds([]);
    await refreshCrawlerIngestPanel();
  };

  const confirmCrawlerIngestUnlock = async (password) => {
    if (crawlerIngestUnlockBusy) return;
    if (!password) {
      setCrawlerIngestUnlockError('请输入维护密码');
      return;
    }

    setCrawlerIngestUnlockBusy(true);
    setCrawlerIngestUnlockError('');
    try {
      const data = await fetchCrawlerIngestTab('pending', password);
      if (!data) return;
      setCrawlerIngestPassword(password);
      closeCrawlerIngestUnlockModal();
      setView('crawler-ingest');
      setCrawlerIngestTab('pending');
      setCrawlerIngestSelectedIds([]);
    } finally {
      setCrawlerIngestUnlockBusy(false);
    }
  };

  const leaveCrawlerIngestView = () => {
    if (crawlerIngestPollRef.current) {
      clearInterval(crawlerIngestPollRef.current);
      crawlerIngestPollRef.current = null;
    }
    setView('list');
    setCrawlerIngestSelectedIds([]);
  };

  const toggleCrawlerIngestRow = (id) => {
    setCrawlerIngestSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const selectAllCrawlerPending = () => {
    setCrawlerIngestSelectedIds(crawlerIngestPendingList.map((r) => r.id));
  };

  const selectAllCrawlerFailed = () => {
    setCrawlerIngestSelectedIds(crawlerIngestFailedList.map((r) => r.id));
  };

  const selectAllCrawlerProcessing = () => {
    setCrawlerIngestSelectedIds(crawlerIngestProcessingList.map((r) => r.id));
  };

  const clearCrawlerIngestSelection = () => setCrawlerIngestSelectedIds([]);

  useEffect(() => {
    if (!mounted) return;
    fetchCrawlerIngestStatus();
    loadSitePlan();
  }, [mounted]);
  useEffect(() => { if (mounted) fetchPosts(); }, [mounted]);
  useEffect(() => {
    if (mounted && view === 'list') loadGalleryStorage();
  }, [mounted, view]);

  useEffect(() => {
    if (view === 'edit') {
      window.history.pushState({ view: 'edit' }, '', '?mode=edit');
    } else {
      if (window.location.search.includes('mode=edit')) window.history.back();
    }
    // Phase3: 浏览器返回键离开编辑器时，dirty 则把 URL 推回编辑态并弹三选一
    const onPopState = () => {
      if (view !== 'edit') return;
      if (dirtyRef.current) {
        window.history.pushState({ view: 'edit' }, '', '?mode=edit');
        pendingLeaveRef.current = { type: 'action', action: () => leaveEditView() };
        setLeaveConfirmOpen(true);
        return;
      }
      leaveEditView();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [view]);

  useEffect(() => {
    if (view === 'crawler-ingest') {
      fetchCrawlerIngestTab(crawlerIngestTab);
    }
  }, [view, crawlerIngestTab]);

  useEffect(() => {
    if (activeTab !== 'Post') {
      setListSelectMode(false);
      setSelectedPostIds([]);
    }
  }, [activeTab]);

  useEffect(() => { if (galleryAd.enabled) setGalleryAdEditing(false); }, [galleryAd.enabled]);
  useEffect(() => { if (vendingEnabled) setVendingEditing(false); }, [vendingEnabled]);
  useEffect(() => { if (shopBanner.enabled) setShopBannerEditing(false); }, [shopBanner.enabled]);
  useEffect(() => { if (announcementPopup.enabled) setAnnouncementPopupEditing(false); }, [announcementPopup.enabled]);
  useEffect(() => { if (popupAd.enabled) setPopupAdEditing(false); }, [popupAd.enabled]);
  useEffect(() => { if (clickAd.enabled) setClickAdEditing(false); }, [clickAd.enabled]);

  // 双模状态机解析
  const parseContentToBlocks = (md) => {
    if(!md) return [];
    const lines = md.split(/\r?\n/);
    const res = [];
    let buffer = []; let isLocking = false; let lockPwd = ''; let lockBuffer = [];  
    let lockMode = null;

    const stripMd = (str) => { const match = str.match(/(?:!|)?\[.*?\]\((.*?)\)/); return match ? match[1] : str; };
    const flushBuffer = () => {
      if (buffer.length > 0) {
        // 正文行保留原样（含行内 [文字](url)），不要洗成纯 URL
        const joined = buffer.join('\n').trim();
        if (joined) {
           if (joined.startsWith('`') && joined.endsWith('`') && joined.length > 1) {
              res.push({ id: Date.now() + Math.random(), type: 'note', content: joined.slice(1, -1) });
           } else {
              res.push({ id: Date.now() + Math.random(), type: 'text', content: joined });
           }
        }
        buffer = [];
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!isLocking && trimmed.startsWith(':::lock')) {
        flushBuffer(); isLocking = true; lockMode = 'explicit';
        lockPwd = trimmed.replace(':::lock', '').replace(/[>*\s🔒]/g, '').trim();
        continue;
      }

      if (!isLocking && trimmed.match(/^>\s*🔒\s*(\*\*)?LOCK:(.*?)(\*\*)?/)) {
        flushBuffer(); isLocking = true; lockMode = 'implicit';
        const match = trimmed.match(/LOCK:(.*?)(\*|$)/);
        lockPwd = match ? match[1].trim() : '';
        continue;
      }
      
      if (isLocking) {
        if (lockMode === 'explicit' && trimmed === ':::') {
           isLocking = false;
           const joinedLock = lockBuffer.map(stripMd).join('\n').trim();
           const lb = splitLockBody(joinedLock);
           res.push({ id: Date.now() + Math.random(), type: 'lock', pwd: lockPwd, content: lb.text, images: lb.images });
           lockBuffer = [];
           continue;
        }
        if (lockMode === 'implicit' && !trimmed.startsWith('>') && trimmed !== '') {
           isLocking = false;
           const joinedLock = lockBuffer.join('\n').trim();
           const lb = splitLockBody(joinedLock);
           res.push({ id: Date.now() + Math.random(), type: 'lock', pwd: lockPwd, content: lb.text, images: lb.images });
           lockBuffer = [];
           i--;
           continue;
        }

        let contentLine = line;
        if (lockMode === 'implicit') {
            if (contentLine.startsWith('> ')) contentLine = contentLine.substring(2);
            else if (contentLine.startsWith('>')) contentLine = contentLine.substring(1);
        }
        if (contentLine.trim() === '---') continue;
        if (contentLine.trim() === '') continue;
        lockBuffer.push(contentLine);
        continue;
      }

      if (trimmed.startsWith('# ')) { flushBuffer(); res.push({ id: Date.now() + Math.random(), type: 'h1', content: trimmed.replace('# ', '') }); continue; }
      const imgUrl = extractImageUrl(trimmed);
      if (imgUrl) { flushBuffer(); res.push({ id: Date.now() + Math.random(), type: 'image', content: imgUrl }); continue; }
      if (!trimmed) { flushBuffer(); continue; }
      buffer.push(line);
    }
    
    if (isLocking) {
        const joinedLock = lockMode === 'implicit' ? lockBuffer.join('\n').trim() : lockBuffer.map(stripMd).join('\n').trim();
        const lb = splitLockBody(joinedLock);
        res.push({ id: Date.now() + Math.random(), type: 'lock', pwd: lockPwd, content: lb.text, images: lb.images });
    } else {
        flushBuffer();
    }
    return res;
  };

  // 🟢 带自动重试的取数：规避 dev 模式 API 路由「首次访问即时编译」导致的首点失败
  const fetchPostById = async (id) => {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch('/api/admin/post?id=' + id);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        if (!d.success) throw new Error(d.error || '加载失败');
        return d.post;
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await new Promise(res => setTimeout(res, 400));
      }
    }
    throw lastErr;
  };

  const handlePreview = async (p) => {
    setLoading(true);
    try {
      const post = await fetchPostById(p.id);
      if (post && post.rawBlocks) setPreviewData(post);
    } catch (e) {
      alert('加载预览失败：' + e.message);
    } finally { setLoading(false); }
  };

  const handleEdit = async (p) => {
    if (loading) return; // P11-C3: 进行中早退
    setLoading(true);
    // H2: 进入新的编辑器会话
    editorSessionRef.current += 1;
    resetGalleryItems();
    // Phase3: 打开文章 = 数据加载/重置，确保未保存标记干净（不误标）
    clearDirty();
    setEditorBlocks((prev) => {
      revokePendingEditorMedia(prev);
      return [];
    });
    try {
      const post = await fetchPostById(p.id);
      if (post) {
        setForm(post);
        const ebRaw = (Array.isArray(post.editorBlocks) && post.editorBlocks.length)
          ? normalizeLoadedEditorBlocks(post.editorBlocks)
          : normalizeLoadedEditorBlocks(parseContentToBlocks(post.content));
        let galleryItemsLoaded = [];
        if (post.slug) {
          try {
            const gr = await fetch(`/api/admin/gallery?slug=${encodeURIComponent(post.slug)}`);
            const gd = await gr.json();
            if (gd.success) {
              galleryItemsLoaded = (gd.images || []).map(remoteFromApiImage);
            }
          } catch {
            galleryItemsLoaded = [];
          }
        }
        const restored = restoreEditorCoverState({
          savedCoverUrl: post.cover,
          blocks: ebRaw,
          galleryItems: galleryItemsLoaded,
        });
        setCoverSettings(restored.coverSettings);
        setEditorBlocks(restored.blocks);
        setGalleryItems(restored.galleryItems);
        setGalleryDirty(false);
        setShowManualCoverInput(restored.coverSettings.mode === COVER_MODE_URL);
        setCurrentId(p.id);
        editingSlugRef.current = post.slug || null;
        editingCategoryRef.current = post.category || null;
        editingTagsRef.current = post.tags || null;
        editingStatusRef.current = p.status || '';
        setView('edit');
        setExpandedStep(1);
      }
    } catch (e) {
      alert('加载文章失败：' + e.message);
    } finally { setLoading(false); }
  };
  
  // 🟢 修复：新建时默认 Published
  const handleCreate = () => {
    // H2: 进入新的编辑器会话
    editorSessionRef.current += 1;
    resetGalleryItems();
    resetCoverSettings();
    // Phase3: 新建 = 数据重置，确保未保存标记干净（不误标）
    clearDirty();
    setEditorBlocks((prev) => {
      revokePendingEditorMedia(prev);
      return [];
    });
    setForm({ title: '', slug: generateAdminPostSlug(), excerpt:'', content:'', category:'', tags:'', cover:'', status:'Published', type: 'Post', date: new Date().toISOString().split('T')[0], download: '', download_size: '', download_count: '', article_password: '', linked_product_sku: '', linked_product_url: '', linked_product_price: '' });
    setCurrentId(null);
    editingSlugRef.current = null;
    editingCategoryRef.current = null;
    editingTagsRef.current = null;
    editingStatusRef.current = '';
    setView('edit');
    // 新建文章默认全部 Step 折叠
    setExpandedStep(0);
  };

  // === 🔗 友链管理 ===
  const uploadAvatarFile = (file) => uploadImageToLsky(file);
  const loadFriends = async () => {
    setFriendsLoading(true);
    try {
      const r = await fetch('/api/admin/friends');
      const d = await r.json();
      if (d.success) setFriends(d.friends || []);
      else alert('加载友链失败：' + (d.error || '未知错误'));
    } catch (e) { alert('加载友链失败：' + e.message); }
    finally { setFriendsLoading(false); }
  };
  const openFriends = () => { setView('friends'); loadFriends(); };

  const normalizeSocialLinks = (links = []) => SOCIAL_LINK_PLATFORMS.map((meta) => {
    const found = (links || []).find((item) => item.platform === meta.platform);
    return {
      id: found?.id || null,
      name: found?.name || meta.label,
      platform: meta.platform,
      url: found?.url || '',
      status: found?.status || 'Hidden',
    };
  });

  const loadSocialLinks = async () => {
    setSocialLinksLoading(true);
    try {
      const r = await fetch('/api/admin/social-links');
      const d = await r.json();
      if (d.success) {
        setSocialLinks({
          enabled: d.enabled === true,
          links: normalizeSocialLinks(d.links || []),
        });
      } else {
        alert('加载社媒组件失败：' + (d.error || '未知错误'));
      }
    } catch (e) {
      alert('加载社媒组件失败：' + e.message);
    } finally {
      setSocialLinksLoading(false);
    }
  };

  const openSocialLinks = () => {
    setView('social-links');
    loadSocialLinks();
  };

  const updateSocialLink = (platform, patch) => {
    setSocialLinks((prev) => ({
      ...prev,
      links: normalizeSocialLinks(prev.links).map((item) =>
        item.platform === platform ? { ...item, ...patch } : item
      ),
    }));
  };

  const saveSocialLinks = async (patch = {}) => {
    if (socialLinksSaving) return; // P11-C3: 进行中早退
    const next = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : socialLinks.enabled,
      links: normalizeSocialLinks(socialLinks.links),
    };

    for (const item of next.links) {
      const url = (item.url || '').trim();
      if (url && !/^https?:\/\//i.test(url)) {
        alert(`${item.name || item.platform} 的链接需要以 http 或 https 开头`);
        return;
      }
    }

    setSocialLinksSaving(true);
    try {
      const r = await fetch('/api/admin/social-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const d = await r.json();
      if (!d.success) {
        alert('保存社媒组件失败：' + (d.error || '未知错误'));
        return;
      }
      setSocialLinks({
        enabled: d.enabled === true,
        links: normalizeSocialLinks(d.links || []),
      });
      showAdminToast(d.enabled ? '社媒组件已保存，正在更新前台…' : '社媒组件已关闭，正在更新前台…');
      void runBatchedRevalidation({
        listScope: 'social-links',
        freshTheme: true,
        contentChange: true,
        progressLabels: {
          listing: '正在统计社媒组件页面…',
          running: '正在更新社媒组件…',
          doneOk: '社媒组件已同步到前台页面',
          donePartial: '部分页面会稍后自动更新',
          hintPartial: '个别页面未能更新，可重新保存社媒组件',
          hintOk: '社媒组件相关页面已更新',
        },
      }).then((rev) => {
        if (rev.failed > 0) showAdminToast(`部分页面更新失败：${rev.failed}/${rev.total}`);
      }).catch((e) => console.warn('社媒组件增量刷新失败', e));
    } catch (e) {
      alert('保存社媒组件失败：' + e.message);
    } finally {
      setSocialLinksSaving(false);
    }
  };

  const startVendingEditing = () => {
    vendingSnapshotRef.current = { enabled: vendingEnabled, title: vendingTitle, url: vendingUrl };
    setVendingEditing(true);
  };
  const discardVendingEditing = () => {
    const snap = vendingSnapshotRef.current;
    if (snap) {
      setVendingEnabled(snap.enabled);
      setVendingTitle(snap.title);
      setVendingUrl(snap.url);
    }
    setVendingEditing(false);
  };
  const startShopBannerEditing = () => {
    shopBannerSnapshotRef.current = { ...shopBanner };
    setShopBannerEditing(true);
  };
  const discardShopBannerEditing = () => {
    const snap = shopBannerSnapshotRef.current;
    if (snap) setShopBanner(snap);
    setShopBannerUpload(null);
    setShopBannerUploadError('');
    setShopBannerEditing(false);
  };
  const startAnnouncementPopupEditing = () => {
    announcementPopupSnapshotRef.current = { ...announcementPopup };
    setAnnouncementPopupEditing(true);
  };
  const discardAnnouncementPopupEditing = () => {
    const snap = announcementPopupSnapshotRef.current;
    if (snap) setAnnouncementPopup(snap);
    setAnnouncementPopupEditing(false);
  };
  const startPopupAdEditing = () => {
    popupAdSnapshotRef.current = { ...popupAd };
    setPopupAdEditing(true);
  };
  const discardPopupAdEditing = () => {
    const snap = popupAdSnapshotRef.current;
    if (snap) setPopupAd(snap);
    setPopupAdEditing(false);
  };
  const startClickAdEditing = () => {
    clickAdSnapshotRef.current = { ...clickAd };
    setClickAdEditing(true);
  };
  const discardClickAdEditing = () => {
    const snap = clickAdSnapshotRef.current;
    if (snap) setClickAd(snap);
    setClickAdEditing(false);
  };
  const startGalleryAdEditing = () => {
    galleryAdSnapshotRef.current = { ...galleryAd };
    setGalleryAdEditing(true);
  };
  const discardGalleryAdEditing = () => {
    const snap = galleryAdSnapshotRef.current;
    if (snap) setGalleryAd(snap);
    setGalleryAdEditing(false);
  };

  // === 📢 Gallery 广告位 ===
  const loadGalleryAd = async () => {
    setGalleryAdLoading(true);
    try {
      const r = await fetch('/api/admin/gallery-ad');
      const d = await r.json();
      if (d.success) {
        const ad = d.ad || {};
        setGalleryAd({
          id: ad.id || null,
          enabled: ad.enabled === true,
          url: ad.url || '',
          promoText: ad.promoText || '',
          cover: ad.cover || '',
        });
      } else alert('加载广告位失败：' + (d.error || '未知错误'));
    } catch (e) { alert('加载广告位失败：' + e.message); }
    finally { setGalleryAdLoading(false); }
  };
  const openGalleryAd = () => { discardGalleryAdEditing(); setView('gallery-ad'); loadGalleryAd(); };

  // === 🛒 贩售机全站开关 ===
  const loadVending = async () => {
    setVendingLoading(true);
    try {
      const r = await fetch('/api/admin/vending');
      const d = await r.json();
      if (d.success) {
        setVendingEnabled(d.enabled !== false);
        setVendingTitle(d.title || '贩售机');
        setVendingUrl(d.url || 'https://store.proplus.onl/buy');
      }
      else alert('加载贩售机设置失败：' + (d.error || '未知错误'));
    } catch (e) { alert('加载贩售机设置失败：' + e.message); }
    finally { setVendingLoading(false); }
  };
  const openVending = () => {
    setVendingAddressUnlocked(false);
    setVendingAddressPassword('');
    setVendingAddressUnlockError('');
    discardVendingEditing();
    setView('vending');
    loadVending();
  };

  // === BLOG 分层 P8:去除平台角标(专业版权益) ===
  const loadBrandClean = async () => {
    setBrandCleanLoading(true);
    try {
      const r = await fetch('/api/admin/brand-clean');
      const d = await r.json();
      if (d.success) {
        setBrandCleanEnabled(d.enabled === true);
        if (d.plan) setSitePlan(d.plan === 'pro' ? 'pro' : 'free');
      }
    } catch {
      // 忽略:保持默认关闭
    } finally {
      setBrandCleanLoading(false);
    }
  };
  const openBrandClean = () => {
    setView('brand-clean');
    loadBrandClean();
  };
  const toggleBrandClean = async (next) => {
    if (brandCleanSaving) return; // P11-C3: 进行中早退
    if (sitePlan !== 'pro') {
      alert('去除平台角标为专业版权益，升级后可用');
      return;
    }
    setBrandCleanSaving(true);
    try {
      const r = await fetch('/api/admin/brand-clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const d = await r.json();
      if (d.success) {
        setBrandCleanEnabled(d.enabled === true);
        // P10-B4:去除方向提示完整生效时效(单例 toast,合并为一条避免覆盖)
        showAdminToast(
          d.enabled
            ? '已关闭平台角标，网站完整生效需等待10-30分钟'
            : '已恢复平台角标，正在更新前台…'
        );
        void runBatchedRevalidation({
          listScope: 'shell',
          freshTheme: true,
          contentChange: true,
          progressLabels: {
            listing: '正在统计页面…',
            running: '正在更新角标展示…',
            doneOk: '角标设置已同步到前台页面',
            donePartial: '部分页面会稍后自动更新',
            hintPartial: '个别页面未能更新，可重新保存角标设置',
            hintOk: '角标相关页面已更新',
          },
        }).then((rev) => {
          if (rev.failed > 0) showAdminToast(`部分页面更新失败（${rev.failed}/${rev.total}）`);
        }).catch((e) => console.warn('角标增量刷新失败', e));
      } else alert('保存失败：' + (d.error || '未知错误'));
    } catch (e) { alert('保存失败：' + e.message); }
    finally { setBrandCleanSaving(false); }
  };

  // === P14:内容保护(全主题;读者端客户端防护,无需 revalidate) ===
  const loadContentProtect = async () => {
    setContentProtectLoading(true);
    try {
      const r = await fetch('/api/admin/content-protect');
      const d = await r.json();
      if (d.success) setContentProtectEnabled(d.enabled === true);
    } catch {
      // 忽略:保持默认关闭
    } finally {
      setContentProtectLoading(false);
    }
  };
  const openContentProtect = () => {
    setView('content-protect');
    loadContentProtect();
  };
  // 派工单 B3:数据统计面板(面板自身挂载时拉取 /api/admin/stats,此处仅切视图)
  const openStats = () => {
    setView('stats');
  };
  const toggleContentProtect = async (next) => {
    if (contentProtectSaving) return; // P11-C3: 进行中早退
    setContentProtectSaving(true);
    try {
      const r = await fetch('/api/admin/content-protect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const d = await r.json();
      if (d.success) {
        setContentProtectEnabled(d.enabled === true);
        showAdminToast(
          d.enabled
            ? '内容保护已开启，读者端下次访问生效'
            : '内容保护已关闭，读者端下次访问生效'
        );
      } else alert('保存失败：' + (d.error || '未知错误'));
    } catch (e) { alert('保存失败：' + e.message); }
    finally { setContentProtectSaving(false); }
  };

  const loadAnnouncementPopup = async () => {
    setAnnouncementPopupLoading(true);
    try {
      const r = await fetch('/api/admin/announcement-popup');
      const d = await r.json();
      if (d.success) {
        setAnnouncementPopup({
          id: d.popup?.id || null,
          enabled: d.popup?.enabled === true,
          title: d.popup?.title || '',
          content: d.popup?.content || '',
          image: d.popup?.image || '',
          buttonText: d.popup?.buttonText || '',
          buttonUrl: d.popup?.buttonUrl || '',
        });
      } else {
        alert('加载公告弹窗失败：' + (d.error || '未知错误'));
      }
    } catch (e) {
      alert('加载公告弹窗失败：' + e.message);
    } finally {
      setAnnouncementPopupLoading(false);
    }
  };

  const openAnnouncementPopup = () => {
    discardAnnouncementPopupEditing();
    setView('announcement-popup');
    loadAnnouncementPopup();
  };

  const loadPopupAd = async () => {
    setPopupAdLoading(true);
    try {
      const r = await fetch('/api/admin/popup-ad');
      const d = await r.json();
      if (d.success) {
        setPopupAd({
          id: d.popupAd?.id || null,
          enabled: d.popupAd?.enabled === true,
          title: d.popupAd?.title || '',
          content: d.popupAd?.content || '',
          image: d.popupAd?.image || '',
          buttonText: d.popupAd?.buttonText || '',
          buttonUrl: d.popupAd?.buttonUrl || '',
        });
      } else {
        alert('加载弹窗广告失败：' + (d.error || '未知错误'));
      }
    } catch (e) {
      alert('加载弹窗广告失败：' + e.message);
    } finally {
      setPopupAdLoading(false);
    }
  };

  const openPopupAd = () => {
    discardPopupAdEditing();
    setView('popup-ad');
    loadPopupAd();
  };

  const loadClickAd = async () => {
    setClickAdLoading(true);
    try {
      const r = await fetch('/api/admin/click-ad');
      const d = await r.json();
      if (d.success) {
        setClickAd({
          id: d.clickAd?.id || null,
          enabled: d.clickAd?.enabled === true,
          title: d.clickAd?.title || '',
          url: d.clickAd?.url || '',
        });
      } else {
        alert('加载遮罩广告失败：' + (d.error || '未知错误'));
      }
    } catch (e) {
      alert('加载遮罩广告失败：' + e.message);
    } finally {
      setClickAdLoading(false);
    }
  };

  const openClickAd = () => {
    discardClickAdEditing();
    setView('click-ad');
    loadClickAd();
  };

  // P18-C4-1: Banner 加载/保存(仅 shop 主题首页生效)
  const loadShopBanner = async () => {
    setShopBannerLoading(true);
    try {
      const r = await fetch('/api/admin/banner');
      const d = await r.json();
      if (d.success) {
        setShopBanner({
          id: d.banner?.id || null,
          enabled: d.banner?.enabled === true,
          imagesText: Array.isArray(d.banner?.images) ? d.banner.images.join('\n') : '',
          link: d.banner?.link || '',
        });
      } else {
        alert('加载 Banner 失败：' + (d.error || '未知错误'));
      }
    } catch (e) {
      alert('加载 Banner 失败：' + e.message);
    } finally {
      setShopBannerLoading(false);
    }
  };

  const openShopBanner = () => {
    discardShopBannerEditing();
    setView('shop-banner');
    loadShopBanner();
  };

  // P18C43-D3: Banner 图片列表派生/写回(仍用换行分隔的 imagesText 承载,保存路径不变)
  const getShopBannerImages = () => (shopBanner.imagesText || '').split('\n').map(s => s.trim()).filter(Boolean);
  const setShopBannerImages = (images) => setShopBanner(prev => ({ ...prev, imagesText: images.join('\n') }));

  const resetShopBannerDragOver = () => {
    shopBannerDragDepthRef.current = 0;
    setShopBannerDragOver(false);
  };

  // P18C43-D3: 拖入/点选图片 → uploadImageToLsky 逐张上传 → 追加缩略图(上限 8 张)
  const handleShopBannerFiles = async (fileList) => {
    const files = Array.from(fileList || []).filter(f => f.type && f.type.startsWith('image/'));
    if (files.length === 0) return;
    const current = getShopBannerImages();
    if (current.length + files.length > 8) {
      alert('Banner 图片最多 8 张（当前已有 ' + current.length + ' 张）');
      return;
    }
    setShopBannerUploadError('');
    setShopBannerUpload({ done: 0, total: files.length });
    const uploaded = [];
    try {
      for (let i = 0; i < files.length; i++) {
        try {
          const url = await uploadImageToLsky(files[i]);
          if (url) uploaded.push(url);
        } catch (err) {
          setShopBannerUploadError('第 ' + (i + 1) + ' 张上传失败：' + (err?.message || '未知错误'));
        }
        setShopBannerUpload({ done: i + 1, total: files.length });
      }
    } finally {
      setShopBannerUpload(null);
    }
    if (uploaded.length > 0) {
      const before = getShopBannerImages();
      setShopBannerImages([...before, ...uploaded].slice(0, 8));
    }
  };

  // P18C43-D3: 缩略图拖拽排序(拖到目标缩略图上松手即插入)
  const handleShopBannerThumbDragStart = (index, e) => {
    setShopBannerDragIndex(index);
    try { e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* noop */ }
  };
  const handleShopBannerThumbDrop = (index, e) => {
    e.preventDefault();
    e.stopPropagation();
    const from = shopBannerDragIndex;
    setShopBannerDragIndex(null);
    if (from == null || from === index) return;
    const images = getShopBannerImages();
    if (from < 0 || from >= images.length) return;
    const [moved] = images.splice(from, 1);
    images.splice(index, 0, moved);
    setShopBannerImages(images);
  };

  const saveShopBanner = async (patch = {}) => {
    if (shopBannerSaving) return; // P11-C3: 进行中早退
    const imagesText = patch.imagesText ?? shopBanner.imagesText ?? '';
    const images = imagesText.split('\n').map(s => s.trim()).filter(Boolean);
    const link = (patch.link ?? shopBanner.link ?? '').trim();
    const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : shopBanner.enabled === true;
    const invalidImage = images.find(u => !/^https?:\/\//i.test(u));
    if (invalidImage) {
      alert('图片地址请填写 http(s) 开头的直链：' + invalidImage);
      return;
    }
    if (images.length > 8) {
      alert('Banner 图片最多 8 张');
      return;
    }
    if (link && !/^https?:\/\//i.test(link) && !link.startsWith('/')) {
      alert('跳转链接请填写 http(s) 开头的网址，或 / 开头的站内路径');
      return;
    }
    if (enabled && images.length === 0) {
      alert('开启 Banner 前请至少填写一张图片地址');
      return;
    }
    setShopBannerSaving(true);
    try {
      const r = await fetch('/api/admin/banner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, images, link }),
      });
      const d = await r.json();
      if (!d.success) {
        alert('保存 Banner 失败：' + (d.error || '未知错误'));
        return;
      }
      const saved = d.banner || { enabled, images, link };
      setShopBanner({
        id: saved.id || null,
        enabled: saved.enabled === true,
        imagesText: Array.isArray(saved.images) ? saved.images.join('\n') : imagesText,
        link: saved.link || '',
      });
      showAdminToast(saved.enabled ? 'Banner 已保存，正在更新前台…' : 'Banner 已关闭，正在更新前台…');
      void runBatchedRevalidation({
        listScope: 'banner',
        freshTheme: true,
        contentChange: true,
        progressLabels: {
          listing: '正在统计 Banner 页面…',
          running: '正在更新 Banner…',
          doneOk: 'Banner 已同步到前台页面',
          donePartial: '部分页面会稍后自动更新',
          hintPartial: '个别页面未能更新，可重新保存 Banner',
          hintOk: 'Banner 相关页面已更新',
        },
      }).then((rev) => {
        if (rev.failed > 0) showAdminToast(`部分页面更新失败（${rev.failed}/${rev.total}）`);
      }).catch((e) => console.warn('Banner 增量刷新失败', e));
    } catch (e) {
      alert('保存 Banner 失败：' + e.message);
    } finally {
      setShopBannerSaving(false);
    }
  };

  const saveClickAd = async (patch = {}) => {
    if (clickAdSaving) return; // P11-C3: 进行中早退
    if (adsLocked) return; // 免费版广告位不可用(灰态防绕过;前台也不会渲染)
    const next = {
      ...clickAd,
      ...patch,
      title: (patch.title ?? clickAd.title ?? '').trim(),
      url: (patch.url ?? clickAd.url ?? '').trim(),
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : clickAd.enabled === true,
    };
    if (next.url && !/^https?:\/\//i.test(next.url) && !next.url.startsWith('/')) {
      alert('广告链接请填写 http(s) 开头的网址，或 / 开头的站内路径');
      return;
    }
    if (next.enabled && !next.url) {
      alert('开启遮罩广告前请填写广告链接');
      return;
    }
    setClickAdSaving(true);
    try {
      const r = await fetch('/api/admin/click-ad', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const d = await r.json();
      if (!d.success) {
        alert('保存遮罩广告失败：' + (d.error || '未知错误'));
        return;
      }
      const saved = d.clickAd || next;
      setClickAd({
        id: saved.id || null,
        enabled: saved.enabled === true,
        title: saved.title || '',
        url: saved.url || '',
      });
      showAdminToast(saved.enabled ? '遮罩广告已保存，正在更新前台…' : '遮罩广告已关闭，正在更新前台…');
      void runBatchedRevalidation({
        listScope: 'click-ad',
        freshTheme: true,
        contentChange: true,
        progressLabels: {
          listing: '正在统计遮罩广告页面…',
          running: '正在更新遮罩广告…',
          doneOk: '遮罩广告已同步到前台页面',
          donePartial: '部分页面会稍后自动更新',
          hintPartial: '个别页面未能更新，可重新保存遮罩广告',
          hintOk: '遮罩广告相关页面已更新',
        },
      }).then((rev) => {
        if (rev.failed > 0) showAdminToast(`部分页面更新失败（${rev.failed}/${rev.total}）`);
      }).catch((e) => console.warn('遮罩广告增量刷新失败', e));
    } catch (e) {
      alert('保存遮罩广告失败：' + e.message);
    } finally {
      setClickAdSaving(false);
    }
  };

  const savePopupAd = async (patch = {}) => {
    if (popupAdSaving) return; // P11-C3: 进行中早退
    if (adsLocked) return; // 免费版广告位不可用(灰态防绕过;前台也不会渲染)
    const next = {
      ...popupAd,
      ...patch,
      title: (patch.title ?? popupAd.title ?? '').trim(),
      content: (patch.content ?? popupAd.content ?? '').trim(),
      image: (patch.image ?? popupAd.image ?? '').trim(),
      buttonText: (patch.buttonText ?? popupAd.buttonText ?? '').trim(),
      buttonUrl: (patch.buttonUrl ?? popupAd.buttonUrl ?? '').trim(),
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : popupAd.enabled === true,
    };
    if (next.buttonUrl && !/^https?:\/\//i.test(next.buttonUrl) && !next.buttonUrl.startsWith('/')) {
      alert('跳转链接请填写 http(s) 开头的网址，或 / 开头的站内路径');
      return;
    }
    if (next.enabled && !next.buttonUrl) {
      alert('开启弹窗广告前请填写跳转链接');
      return;
    }
    if (next.image && !/^https?:\/\//i.test(next.image)) {
      alert('图片地址请填写 http(s) 开头的直链');
      return;
    }
    if (next.enabled && !next.content && !next.image) {
      alert('开启前请先填写内容或上传图片');
      return;
    }
    setPopupAdSaving(true);
    try {
      const r = await fetch('/api/admin/popup-ad', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const d = await r.json();
      if (!d.success) {
        alert('保存弹窗广告失败：' + (d.error || '未知错误'));
        return;
      }
      const saved = d.popupAd || next;
      setPopupAd({
        id: saved.id || null,
        enabled: saved.enabled === true,
        title: saved.title || '',
        content: saved.content || '',
        image: saved.image || '',
        buttonText: saved.buttonText || '',
        buttonUrl: saved.buttonUrl || '',
      });
      showAdminToast(saved.enabled ? '弹窗广告已保存，正在更新前台…' : '弹窗广告已关闭，正在更新前台…');
      void runBatchedRevalidation({
        listScope: 'popup-ad',
        freshTheme: true,
        contentChange: true,
        progressLabels: {
          listing: '正在统计弹窗广告页面…',
          running: '正在更新弹窗广告…',
          doneOk: '弹窗广告已同步到前台页面',
          donePartial: '部分页面会稍后自动更新',
          hintPartial: '个别页面未能更新，可重新保存弹窗广告',
          hintOk: '弹窗广告相关页面已更新',
        },
      }).then((rev) => {
        if (rev.failed > 0) showAdminToast(`部分页面更新失败（${rev.failed}/${rev.total}）`);
      }).catch((e) => console.warn('弹窗广告增量刷新失败', e));
    } catch (e) {
      alert('保存弹窗广告失败：' + e.message);
    } finally {
      setPopupAdSaving(false);
    }
  };

  const uploadPopupAdImage = async (file) => {
    if (!file || adsLocked) return;
    setPopupAdSaving(true);
    try {
      const url = await uploadAvatarFile(file);
      setPopupAd((prev) => ({ ...prev, image: url }));
    } catch (e) {
      alert('上传失败：' + e.message);
    } finally {
      setPopupAdSaving(false);
    }
  };

  const saveAnnouncementPopup = async (patch = {}) => {
    if (announcementPopupSaving) return; // P11-C3: 进行中早退
    const next = {
      ...announcementPopup,
      ...patch,
      title: (patch.title ?? announcementPopup.title ?? '').trim(),
      content: (patch.content ?? announcementPopup.content ?? '').trim(),
      image: (patch.image ?? announcementPopup.image ?? '').trim(),
      // 公告仅作通知：保存时清空旧跳转按钮字段
      buttonText: '',
      buttonUrl: '',
    };
    if (next.image && !/^https?:\/\//i.test(next.image)) {
      alert('图片地址请填写 http(s) 开头的直链');
      return;
    }
    if (next.enabled && !next.content) {
      alert('开启前请先填写通知内容');
      return;
    }
    setAnnouncementPopupSaving(true);
    try {
      const r = await fetch('/api/admin/announcement-popup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const d = await r.json();
      if (!d.success) {
        alert('保存公告弹窗失败：' + (d.error || '未知错误'));
        return;
      }
      const saved = d.popup || next;
      setAnnouncementPopup({
        id: saved.id || null,
        enabled: saved.enabled === true,
        title: saved.title || '',
        content: saved.content || '',
        image: saved.image || '',
        buttonText: saved.buttonText || '',
        buttonUrl: saved.buttonUrl || '',
      });
      showAdminToast(saved.enabled ? '公告弹窗已保存，正在更新前台…' : '公告弹窗已关闭，正在更新前台…');
      void runBatchedRevalidation({
        listScope: 'announcement-popup',
        freshTheme: true,
        contentChange: true,
        progressLabels: {
          listing: '正在统计公告弹窗页面…',
          running: '正在更新公告弹窗…',
          doneOk: '公告弹窗已同步到前台页面',
          donePartial: '部分页面会稍后自动更新',
          hintPartial: '个别页面未能更新，可重新保存公告弹窗',
          hintOk: '公告弹窗相关页面已更新',
        },
      }).then((rev) => {
        if (rev.failed > 0) showAdminToast(`部分页面更新失败：${rev.failed}/${rev.total}`);
      }).catch((e) => console.warn('公告弹窗增量刷新失败', e));
    } catch (e) {
      alert('保存公告弹窗失败：' + e.message);
    } finally {
      setAnnouncementPopupSaving(false);
    }
  };

  const uploadAnnouncementPopupImage = async (file) => {
    if (!file) return;
    setAnnouncementPopupSaving(true);
    try {
      const url = await uploadAvatarFile(file);
      setAnnouncementPopup(prev => ({ ...prev, image: url }));
    } catch (e) {
      alert('公告图片上传失败：' + e.message);
    } finally {
      setAnnouncementPopupSaving(false);
    }
  };

  const confirmVendingAddressUnlock = async (password) => {
    if (vendingAddressUnlockBusy) return;
    if (!password) {
      setVendingAddressUnlockError('请输入维护密码');
      return;
    }

    setVendingAddressUnlockBusy(true);
    setVendingAddressUnlockError('');
    try {
      const r = await fetch('/api/admin/vending?verifyAddress=1', {
        headers: { 'x-admin-maintenance-password': password },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.success === false) {
        setVendingAddressUnlockError(d.error || '维护密码错误');
        return;
      }
      setVendingAddressPassword(password);
      setVendingAddressUnlocked(true);
      closeVendingAddressUnlockModal();
      showAdminToast('贩售机地址编辑已解锁');
    } catch (e) {
      setVendingAddressUnlockError(e.message || '验证失败，请稍后重试');
    } finally {
      setVendingAddressUnlockBusy(false);
    }
  };

  const saveVending = async (patch = {}) => {
    if (vendingSaving) return; // P11-C3: 进行中早退
    const nextEnabled = typeof patch.enabled === 'boolean' ? patch.enabled : vendingEnabled;
    const nextTitle = ((patch.title ?? vendingTitle) || '').trim() || '贩售机';
    const nextUrl = ((patch.url ?? vendingUrl) || '').trim();
    const includeAddress = Boolean(patch.includeAddress);
    if (includeAddress && !vendingAddressUnlocked) {
      setVendingAddressUnlockError('');
      setVendingAddressUnlockClosing(false);
      setVendingAddressUnlockOpen(true);
      return;
    }
    if (includeAddress && !nextUrl.startsWith('http')) { alert('请填写有效的贩售机地址（需以 http 开头）'); return; }
    setVendingSaving(true);
    try {
      const payload = { enabled: nextEnabled };
      if (includeAddress) {
        payload.title = nextTitle;
        payload.url = nextUrl;
        payload.password = vendingAddressPassword;
      }
      const r = await fetch('/api/admin/vending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (d.success) {
        setVendingEnabled(d.enabled !== false);
        setVendingTitle(d.title || nextTitle);
        setVendingUrl(d.url || nextUrl);
        showAdminToast(d.enabled ? '贩售机已保存，正在更新前台…' : '贩售机已关闭，正在更新前台…');
        void runBatchedRevalidation({
          listScope: 'vending',
          freshTheme: true,
          contentChange: true,
          progressLabels: {
            listing: '正在统计贩售机入口页面…',
            running: '正在更新贩售机入口…',
            doneOk: '贩售机入口已同步到前台页面',
            donePartial: '部分页面需稍后自动更新',
            hintPartial: '个页面未能更新，可重新保存贩售机设置',
            hintOk: '全部入口页面已更新',
          },
        }).then((rev) => {
          if (rev.failed > 0) showAdminToast(`部分页面更新失败（${rev.failed}/${rev.total}）`);
        }).catch((e) => console.warn('贩售机增量刷新失败', e));
      } else alert('保存失败：' + (d.error || '未知错误'));
    } catch (e) { alert('保存失败：' + e.message); }
    finally { setVendingSaving(false); }
  };

  const saveGalleryAd = async (patch = {}) => {
    if (galleryAdSaving) return; // P11-C3: 进行中早退
    if (adsLocked) return; // 免费版广告位不可用(灰态防绕过;前台也不会渲染)
    const next = {
      ...galleryAd,
      ...patch,
      url: (patch.url ?? galleryAd.url ?? '').trim(),
      promoText: (patch.promoText ?? galleryAd.promoText ?? '').trim(),
      cover: (patch.cover ?? galleryAd.cover ?? '').trim(),
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : galleryAd.enabled === true,
    };
    if (next.enabled && !next.url.startsWith('http')) {
      alert('开启广告位前请先填写有效的广告链接（需以 http 开头）');
      return;
    }
    if (!next.enabled && next.url && !next.url.startsWith('http')) {
      alert('请填写有效的广告链接（需以 http 开头）');
      return;
    }
    setGalleryAdSaving(true);
    try {
      const r = await fetch('/api/admin/gallery-ad', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: galleryAd.id,
          enabled: next.enabled,
          url: next.url,
          promoText: next.promoText,
          cover: next.cover,
        }),
      });
      const d = await r.json();
      if (d.success) {
        const saved = d.ad || next;
        setGalleryAd({
          id: saved.id || null,
          enabled: saved.enabled === true,
          url: saved.url || '',
          promoText: saved.promoText || '',
          cover: saved.cover || '',
        });
        showAdminToast(saved.enabled ? '广告位已开启，正在更新前台…' : (typeof patch.enabled === 'boolean' ? '广告位已关闭，正在更新前台…' : '广告位已保存，正在更新前台…'));
        await fetchPosts();
        void runBatchedRevalidation({
          listScope: 'gallery-ad',
          freshTheme: true,
          contentChange: true,
          progressLabels: {
            listing: '正在统计文章页…',
            running: '正在更新广告位…',
            doneOk: '广告位已同步到全部文章页',
            donePartial: '部分页面需稍后自动更新',
            hintPartial: '个页面未能更新，可重新保存广告位',
            hintOk: '全部文章页与下载页已更新',
          },
        }).then((rev) => {
          if (rev.failed > 0) showAdminToast(`部分页面更新失败（${rev.failed}/${rev.total}）`);
        }).catch((e) => console.warn('Gallery 广告增量刷新失败', e));
      }
      else alert('保存失败：' + (d.error || '未知错误'));
    } catch (e) { alert('保存失败：' + e.message); }
    finally { setGalleryAdSaving(false); }
  };
  const clearGalleryAd = async () => {
    if (adsLocked) return; // 免费版广告位不可用(灰态防绕过;前台也不会渲染)
    if (!confirm('确定清空广告位配置？前台将不再显示底部横幅。')) return;
    setGalleryAdSaving(true);
    try {
      const r = await fetch('/api/admin/gallery-ad', { method: 'DELETE' });
      const d = await r.json();
      if (d.success) {
        setGalleryAd({ id: null, enabled: false, url: '', promoText: '', cover: '' });
        alert('✓ 广告位已清空');
        await fetchPosts();
        void runBatchedRevalidation({
          listScope: 'gallery-ad',
          freshTheme: true,
          contentChange: true,
        }).catch((e) => console.warn('Gallery 广告增量刷新失败', e));
      } else alert('清空失败：' + (d.error || '未知错误'));
    } catch (e) { alert('清空失败：' + e.message); }
    finally { setGalleryAdSaving(false); }
  };
  const uploadGalleryAdCover = async (file) => {
    if (!file || adsLocked) return;
    setGalleryAdCoverUploading(true);
    try {
      const url = await uploadAvatarFile(file);
      setGalleryAd(prev => ({ ...prev, cover: url }));
    } catch (e) { alert('封面上传失败：' + e.message); }
    finally { setGalleryAdCoverUploading(false); }
  };
  const updateFriendField = (id, key, val) => setFriends(prev => prev.map(f => f.id === id ? { ...f, [key]: val } : f));
  const clearFriendBtn = (key) => setFriendBtnStatus(prev => { const n = { ...prev }; delete n[key]; return n; });
  const saveFriend = async (friend) => {
    if (!friend.name || !friend.name.trim()) return alert('请填写站点名称');
    if (!friend.url || !friend.url.trim()) return alert('请填写站点链接');
    const key = friend.id || 'draft';
    setFriendBtnStatus(prev => ({ ...prev, [key]: 'saving' }));
    try {
      const r = await fetch('/api/admin/friends', { method: 'POST', body: JSON.stringify({ id: friend.id, name: friend.name, url: friend.url, avatar: friend.avatar }) });
      const d = await r.json();
      if (!d.success) { alert('保存失败：' + (d.error || '未知错误')); clearFriendBtn(key); return; }
      if (!friend.id) setFriendDraft({ name: '', url: '', avatar: '' });
      await loadFriends();
      await triggerContentRevalidation({ scope: 'friends' });
      setFriendBtnStatus(prev => ({ ...prev, [key]: 'done' }));
      setTimeout(() => clearFriendBtn(key), 1600);
    } catch (e) { alert('保存失败：' + e.message); clearFriendBtn(key); }
  };
  const deleteFriend = async (id) => {
    if (friendsLoading) return; // P11-C3: 进行中早退
    if (!confirm('确定删除该友链？')) return;
    setFriendsLoading(true);
    try {
      const r = await fetch('/api/admin/friends?id=' + id, { method: 'DELETE' });
      const d = await r.json();
      if (!d.success) alert('删除失败：' + (d.error || '未知错误'));
      await loadFriends();
      await triggerContentRevalidation({ scope: 'friends' });
    } catch (e) { alert('删除失败：' + e.message); }
    finally { setFriendsLoading(false); }
  };
  const uploadFriendAvatar = async (id, file) => {
    if (!file) return;
    updateFriendField(id, '_uploading', true);
    try { const url = await uploadAvatarFile(file); updateFriendField(id, 'avatar', url); }
    catch (e) { alert('头像上传失败：' + e.message); }
    finally { updateFriendField(id, '_uploading', false); }
  };
  const uploadDraftAvatar = async (file) => {
    if (!file) return;
    setFriendDraftUploading(true);
    try { const url = await uploadAvatarFile(file); setFriendDraft(prev => ({ ...prev, avatar: url })); }
    catch (e) { alert('头像上传失败：' + e.message); }
    finally { setFriendDraftUploading(false); }
  };
  // 组件头像(cover)上传
  const uploadCover = async (file) => {
    if (!file) return;
    setCoverUploading(true);
    try { const url = await uploadAvatarFile(file); setFormDirty(prev => ({ ...prev, cover: url })); }
    catch (e) { alert('头像上传失败：' + e.message); }
    finally { setCoverUploading(false); }
  };
  
  // ============ 后台发布队列 ============
  // 更新队列中某条任务的状态/进度
  const updateJob = useCallback((id, patch) => {
    setPublishQueue((q) =>
      q.map((job) => {
        if (job.id !== id) return job;
        const merged = { ...job, ...patch };
        if (merged.status === 'running') {
          merged.lastActivityAt = Date.now();
          if (!patch.stalled) merged.stalled = false;
        }
        return merged;
      })
    );
  }, []);

  const dismissJob = useCallback((id) => {
    setPublishQueue((q) => q.filter((job) => job.id !== id));
  }, []);

  const retryJob = useCallback((id) => {
    cancelledJobsRef.current.delete(id);
    setPublishQueue((q) =>
      q.map((job) =>
        job.id === id
          ? {
              ...job,
              status: 'queued',
              phase: '',
              progress: null,
              error: '',
              stalled: false,
              startedAt: null,
              lastActivityAt: null,
              // 全量重试从零开始，丢弃断点续跑产物
              resumeData: null,
            }
          : job
      )
    );
  }, []);

  // Phase4: 仅重试失败步骤（断点续跑）——phase 保持失败时刻的阶段，resumeData 保留在 job 上
  const retryJobFromPhase = useCallback((id) => {
    cancelledJobsRef.current.delete(id);
    setPublishQueue((q) =>
      q.map((job) =>
        job.id === id
          ? {
              ...job,
              status: 'queued',
              progress: null,
              error: '',
              stalled: false,
              startedAt: null,
              lastActivityAt: null,
            }
          : job
      )
    );
  }, []);

  // Phase4: 失败任务「恢复到编辑器」——payload 回填编辑器后移除队列任务（仅普通文章，Widget 不提供）
  const restoreJobToEditor = useCallback((id) => {
    const job = publishQueue.find((j) => j.id === id);
    if (!job || job.status !== 'error') return;
    const payload = job.payload || {};
    if (payload.isWidget) return;
    const ok = restoreSnapshotToEditor({
      blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
      form: payload.form || {},
      galleryItems: Array.isArray(payload.galleryItems) ? payload.galleryItems : [],
      coverSettings: payload.coverSettings,
      postId: payload.currentId || null,
      slug: payload.previousSlug || payload.form?.slug || '',
    });
    if (!ok) return;
    dismissJob(id);
    setView('edit');
    setExpandedStep(0);
    showAdminToast('已把失败任务恢复到编辑器（内容尚未保存到云端）', 3200);
  }, [publishQueue, restoreSnapshotToEditor, dismissJob]);

  // 取消/移除某条任务：排队中或进行中则标记取消（进行中为协作式取消，到下个阶段停止）
  const removeJob = useCallback((job) => {
    if (job.status === 'queued' || job.status === 'running') {
      cancelledJobsRef.current.add(job.id);
      if (job.status === 'running') {
        queueRunningRef.current = false;
        setTimeout(() => setPublishQueue((q) => [...q]), 0);
      }
    }
    setPublishQueue((q) => q.filter((j) => j.id !== job.id));
  }, []);

  const forceCompleteJob = useCallback((id) => {
    cancelledJobsRef.current.delete(id);
    queueRunningRef.current = false;
    updateJob(id, {
      status: 'success',
      phase: '',
      progress: null,
      error: '',
      stalled: false,
    });
    fetchPosts({ silent: true });
    loadGalleryStorage();
    showAdminToast('已标记完成，将继续处理队列中其余任务');
    setTimeout(() => dismissJob(id), 4000);
    setTimeout(() => setPublishQueue((q) => [...q]), 0);
  }, [updateJob, dismissJob]);

  // 实际执行一条发布任务：完全基于任务快照 payload，不依赖当前编辑器状态
  const runPublishJob = useCallback(async (job) => {
    const { payload } = job;
    // Phase4: 断点续跑——读取上次失败前已完成阶段的中间产物（有则跳过对应上传阶段）
    const resumeData = job.resumeData || null;
    const isCancelled = () => cancelledJobsRef.current.has(job.id);
    const bailIfCancelled = () => {
      if (!isCancelled()) return false;
      cancelledJobsRef.current.delete(job.id);
      return true;
    };

    updateJob(job.id, {
      status: 'running',
      phase: '',
      progress: null,
      error: '',
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      stalled: false,
    });

    try {
      // 🧩 组件(Widget)：仅更新 标题/摘要/头像(cover)
      if (payload.isWidget) {
        updateJob(job.id, { phase: 'post' });
        const res = await fetchWithTimeout('/api/admin/post', {
          method: 'POST',
          body: JSON.stringify({
            id: payload.currentId,
            title: payload.form.title,
            excerpt: payload.form.excerpt,
            cover: payload.form.cover || '',
            slug: payload.form.slug,
            type: 'Widget',
            status: payload.form.status || 'Published',
          }),
        });
        const d = await res.json();
        if (bailIfCancelled()) return;
        if (!d.success) throw new Error(d.error || '保存失败');
        updateJob(job.id, { status: 'success', phase: '', progress: null });
        // H2: 仅当用户未在任务执行期间重新进入编辑器时才清理 dirty
        if (job.sessionRef === editorSessionRef.current) {
          clearDirty();
        }
        // 快照清理 key 来自 job payload，与当前编辑器无关，不应受会话代号约束
        maybeClearSnapshotAfterSave(payload);
        fetchPosts({ silent: true });
        void triggerContentRevalidation({
          scope: 'widget',
          queue: true,
          queueDelayMs: 30_000,
          clearCaches: true,
          freshTheme: true,
          contentChange: true,
          queueReason: 'widget-save',
        }).then((rev) =>
          showRevalidateFeedback(rev, showAdminToast)
        );
        setTimeout(() => dismissJob(job.id), 6000);
        return;
      }

      let blocksForSave = resumeData?.blocks || payload.blocks;

      // 1) 上传正文图片（断点重试：已有上传产物则跳过）
      if (payload.pendingMediaCount > 0 && !resumeData?.blocks) {
        updateJob(job.id, {
          phase: 'media',
          progress: { done: 0, total: payload.pendingMediaCount },
        });
        blocksForSave = await flushEditorBlocksMedia(blocksForSave, {
          onProgress: ({ done, total }) =>
            updateJob(job.id, { progress: { done, total } }),
        });
        jobProgressRef.current[job.id] = {
          ...(jobProgressRef.current[job.id] || {}),
          blocks: blocksForSave,
        };
      }
      if (bailIfCancelled()) return;

      // 2) 若有 pending 图库，先上传以便解析图库封面 URL（断点重试：已有上传产物则跳过）
      let galleryItemsForSave = resumeData?.galleryItems || payload.galleryItems || [];
      if (
        payload.pendingGalleryCount > 0 &&
        galleryItemsForSave.length > 0 &&
        !resumeData?.galleryItems
      ) {
        updateJob(job.id, {
          phase: 'gallery',
          progress: { done: 0, total: payload.pendingGalleryCount },
        });
        galleryItemsForSave = await flushGalleryUploads({
          slug: payload.form.slug,
          postTitle: payload.form.title,
          postNotionId: payload.currentId,
          items: galleryItemsForSave,
          onProgress: ({ done, total }) =>
            updateJob(job.id, { progress: { done, total } }),
        });
        jobProgressRef.current[job.id] = {
          ...(jobProgressRef.current[job.id] || {}),
          galleryItems: galleryItemsForSave,
        };
      }
      if (bailIfCancelled()) return;

      // 3) 写入 Notion 文章
      updateJob(job.id, { phase: 'post', progress: null });
      const fullContent = blocksToMarkdown(blocksForSave);
      // serializeBlocksForSave 白名单不含 todo 的 checked，此处按原块补回，避免保存丢失
      const blocksData = serializeBlocksForSave(blocksForSave).map((b, i) => {
        const origin = blocksForSave[i];
        if (b.type === 'todo' && Array.isArray(origin && origin.checked)) {
          return { ...b, checked: origin.checked };
        }
        return b;
      });
      const coverForSave = resolveNotionCoverForSave({
        coverMode: payload.coverSettings?.mode || 'auto',
        manualCoverUrl: payload.coverSettings?.manualUrl || '',
        blocks: blocksForSave,
        galleryItems: galleryItemsForSave,
      });

      const res = await fetchWithTimeout('/api/admin/post', {
        method: 'POST',
        body: JSON.stringify({
          ...payload.form,
          cover: coverForSave,
          status: payload.form.status || 'Published',
          content: fullContent,
          blocksData,
          // P11-C1: post 曾成功过（重试）时携带已建页 id，走 update 不再重复 create
          id: job.createdId || resumeData?.notionId || payload.currentId,
          type: payload.form.type || 'Post',
          previousSlug: payload.previousSlug || '',
        }),
      });
      const d = await res.json();
      if (bailIfCancelled()) return;
      if (!d.success) throw new Error(d.error || '保存失败');
      // P18-C4-5: 商品码联动结果提示(查不到/下架/接口异常均不阻塞保存,这里补提示)
      if (d.linkedProductFetchError) {
        showAdminToast(`商品信息：${d.linkedProductFetchError}`, 4200);
      }
      const newId = d.id || payload.currentId;
      // Phase4: post 阶段成功，回写中间产物（断点续跑时 refresh/gallery 同步失败可免重传）
      // P11-C1: 记录已建页 id（jobProgressRef + job.createdId），后续任何重试路径识别后转 update，避免重复建稿
      jobProgressRef.current[job.id] = {
        ...(jobProgressRef.current[job.id] || {}),
        blocks: blocksForSave,
        galleryItems: galleryItemsForSave,
        notionId: newId,
      };
      if (newId) updateJob(job.id, { createdId: newId });

      const saveSlug = payload.form.slug || '';
      const saveType = payload.form.type || 'Post';
      const saveStatus = payload.form.status || 'Published';
      const isDraftSave = saveStatus === 'Draft';
      const saveScope = resolveSaveRevalidateScope(saveType, saveSlug);
      const previousSlug = payload.previousSlug || '';
      // 首发 = 无 currentId（新文章）或编辑前是草稿（草稿转首发同样要 new-post 索引确认）
      const isFirstPublish = !payload.currentId || payload.previousStatus === 'Draft';

      if (isFirstPublish && newId && saveType === 'Post' && !isDraftSave) {
        const optimisticPost = {
          id: newId,
          title: payload.form.title || '无标题',
          slug: saveSlug,
          excerpt: payload.form.excerpt || '',
          category: payload.form.category || '',
          tags: payload.form.tags || '',
          status: saveStatus,
          type: 'Post',
          date: payload.form.date || '',
          cover: coverForSave || '',
          pinned: false,
          favourited: false,
          download: payload.form.download || '',
          download_size: payload.form.download_size || '',
          download_count: payload.form.download_count || '',
        };
        setPosts((currentPosts) => [
          optimisticPost,
          ...currentPosts.filter((post) => post.id !== newId),
        ]);
        registerPendingPostSync({
          id: newId,
          title: optimisticPost.title,
          slug: saveSlug,
          category: optimisticPost.category,
          tags: optimisticPost.tags,
          startedAt: Date.now(),
        });
      }

      // 4) 同步图库（排序 / 新建后补写 notion id）
      if (payload.willSyncGallery && galleryItemsForSave.length > 0) {
        if (bailIfCancelled()) return;
        updateJob(job.id, { phase: 'gallery', progress: null });
        await flushGalleryUploads({
          slug: payload.form.slug,
          postTitle: payload.form.title,
          postNotionId: newId,
          items: galleryItemsForSave,
        });
      }
      if (bailIfCancelled()) return;

      updateJob(job.id, { phase: 'refresh', progress: null });

      try {
        if (saveScope === 'post') {
          // M2: 首发存为草稿不入队（前台无此文，Published 索引永远不收录，重试必败）；
          // 已发布文章改存草稿（!isFirstPublish && isDraftSave）按普通保存入队（post-save / 3 次尝试），前台需移除
          if (!(isFirstPublish && isDraftSave)) {
            void triggerContentRevalidation({
              scope: 'post',
              slug: saveSlug,
              category: payload.form.category || '',
              tags: payload.form.tags || '',
              previousCategory: payload.previousCategory || '',
              previousTags: payload.previousTags || '',
              previousSlug,
              queue: true,
              queueDelayMs: isFirstPublish ? 60_000 : 30_000,
              clearCaches: true,
              warmPaths: isFirstPublish && !isDraftSave,
              contentChange: true,
              queueReason: isFirstPublish
                ? `new-post:${encodeURIComponent(saveSlug)}`
                : 'post-save',
              queuePriority: 10,
              queueMaxAttempts: isFirstPublish ? 8 : 3,
            })
              .then((rev) => showRevalidateFeedback(rev, showAdminToast))
              .catch((e) => console.warn('文章内页增量刷新失败', e));
          }
        } else if (saveScope === 'page' && saveSlug === 'download') {
          void triggerContentRevalidation({
            scope: 'page',
            slug: saveSlug,
            previousSlug,
            queue: true,
            queueDelayMs: 30_000,
            clearCaches: true,
            freshTheme: true,
            contentChange: true,
            queueReason: 'download-page-save',
            queuePriority: 20,
          }).then((rev) => showRevalidateFeedback(rev, showAdminToast));
        } else if (saveScope === 'page') {
          const rev = await triggerContentRevalidation({
            scope: 'page',
            slug: saveSlug,
            previousSlug,
            queue: true,
            queueDelayMs: 30_000,
            clearCaches: true,
            contentChange: true,
            queueReason: 'page-save',
            queuePriority: 10,
          });
          showRevalidateFeedback(rev, showAdminToast);
        } else if (saveScope === 'gallery-ad' || saveScope === 'vending' || saveScope === 'announcement-popup' || saveScope === 'popup-ad' || saveScope === 'click-ad' || saveScope === 'social-links' || saveScope === 'banner') {
          const scope = saveScope;
          void triggerContentRevalidation({
            scope,
            queue: true,
            queueDelayMs: 30_000,
            clearCaches: true,
            freshTheme: true,
            contentChange: true,
            queueReason: `${scope}-save`,
            queuePriority: 20,
          }).then((rev) => showRevalidateFeedback(rev, showAdminToast));
        } else if (saveScope === 'widget') {
          const rev = await triggerContentRevalidation({
            scope: 'widget',
            queue: true,
            queueDelayMs: 30_000,
            clearCaches: true,
            freshTheme: true,
            contentChange: true,
            queueReason: 'widget-save',
            queuePriority: 10,
          });
          showRevalidateFeedback(rev, showAdminToast);
        }
      } catch (revErr) {
        console.warn('发布增量刷新失败', revErr);
        showAdminToast('内容已保存，但前台刷新未完成，请点右上角「刷新BLOG」');
      }

      updateJob(job.id, { status: 'success', phase: '', progress: null });
      // Phase3: 发布（含存为草稿）成功后清除未保存标记，并清理同文章本地快照
      // H2: 仅当用户未在任务执行期间重新进入编辑器时才执行，避免误清正在编辑的内容
      if (job.sessionRef === editorSessionRef.current) {
        clearDirty();
      }
      // 快照清理 key 来自 job payload，与当前编辑器无关，不应受会话代号约束
      maybeClearSnapshotAfterSave(payload);
      // 后台静默刷新列表，完成的文章无感知出现在内容列表中
      fetchPosts({ silent: true });
      loadGalleryStorage();

      // 成功项稍后自动移除，保持队列整洁
      setTimeout(() => dismissJob(job.id), 6000);
    } catch (e) {
      if (bailIfCancelled()) return;
      // Phase4: 保留失败时刻的 phase（不再清空），并把已完成阶段的中间产物写入 job.resumeData 供断点续跑
      updateJob(job.id, {
        status: 'error',
        progress: null,
        error: e?.message || '发布失败',
        resumeData: jobProgressRef.current[job.id] || null,
      });
      // Phase4: 失败自动入草稿箱（仅普通文章；取消/Widget 不入库）——刷新页面后仍可从草稿箱找回
      if (!payload.isWidget) {
        const failedSnapshotId = saveEditorDraftSnapshot(
          {
            blocks: payload.blocks,
            form: payload.form,
            galleryItems: payload.galleryItems,
            coverSettings: payload.coverSettings,
          },
          {
            kind: 'failed',
            title: (payload.form?.title || '').trim() || '未命名',
            postId: payload.currentId || null,
            slug: payload.form?.slug || '',
          }
        );
        // M3: 本地草稿写入失败时明确提示，避免用户误以为内容已妥善保存
        if (!failedSnapshotId) {
          showAdminToast('本地草稿保存失败（存储不可用）', 3200);
        }
      }
    } finally {
      // 任务结束（成功/失败/取消）清理中间产物引用
      delete jobProgressRef.current[job.id];
    }
  }, [updateJob, dismissJob, registerPendingPostSync, clearDirty, maybeClearSnapshotAfterSave]);

  // 检测长时间无进度心跳的任务（图库大批量上传可持续数分钟，不误判）
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setPublishQueue((q) => {
        let changed = false;
        const next = q.map((job) => {
          if (job.status !== 'running' || !job.lastActivityAt || job.stalled) return job;
          const idleMs = now - job.lastActivityAt;
          if (idleMs > resolvePublishIdleStallMs(job)) {
            changed = true;
            return { ...job, stalled: true };
          }
          return job;
        });
        return changed ? next : q;
      });
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  // 队列调度：一次只跑一条，跑完自动取下一条
  useEffect(() => {
    if (queueRunningRef.current) return;
    const next = publishQueue.find((job) => job.status === 'queued');
    if (!next) return;
    queueRunningRef.current = true;
    runPublishJob(next).finally(() => {
      queueRunningRef.current = false;
      // 触发一次状态更新，让 effect 重新评估下一条
      setPublishQueue((q) => [...q]);
    });
  }, [publishQueue, runPublishJob]);

  // 点击发布：抓取当前编辑器快照入队，立刻清空编辑器以便继续下一篇
  const enqueuePublish = () => {
    if (isThemeLoading) return alert('请等待当前任务完成...');

    const isWidget = form.type === 'Widget';
    const blocks = editorBlocksRef.current || [];
    const pendingMediaCount = isWidget ? 0 : countPendingEditorMedia(blocks);
    const pendingGalleryCount = isWidget ? 0 : countPendingGalleryItems(galleryItems);
    const willSyncGallery =
      !isWidget &&
      !isSimpleCustomPage(form?.slug) &&
      (galleryDirty || pendingGalleryCount > 0);

    const job = {
      id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: (form.title || '').trim() || '未命名',
      status: 'queued',
      phase: '',
      progress: null,
      error: '',
      // H2: 入队时的编辑器会话代号，成功回调据此判断用户是否已重新进入编辑器
      sessionRef: editorSessionRef.current,
      payload: {
        isWidget,
        // 注意：保留对象/File 引用，不做 JSON 克隆（pending 图片含 File，无法序列化）
        // Phase3: 发布确认弹窗选择「存为草稿」时，以 Draft 状态提交 API（post.js 已支持 status 透传）
        form: {
          ...form,
          status: publishAs === 'Draft' ? 'Draft' : (form.status || 'Published'),
        },
        blocks: isWidget ? [] : blocks.slice(),
        galleryItems: isWidget ? [] : galleryItems.slice(),
        currentId,
        previousSlug: editingSlugRef.current || '',
        previousStatus: editingStatusRef.current || '',
        previousCategory: editingCategoryRef.current || '',
        previousTags: editingTagsRef.current || '',
        willSyncGallery,
        pendingMediaCount,
        pendingGalleryCount,
        coverSettings: { ...coverSettings },
      },
    };

    setPublishQueue((q) => [...q, job]);
    showAdminToast(
      publishAs === 'Draft'
        ? `已加入队列（存为草稿）：${job.title}`
        : `已加入发布队列：${job.title}`
    );

    // 清空编辑器，准备下一篇。
    // 不撤销 blob 预览 URL：后台任务仍持有这些 File/预览引用，撤销会影响兜底读取。
    setGalleryItems([]);
    setGalleryDirty(false);
    clearDirty();
    resetCoverSettings();
    setEditorBlocks([]);
    editingSlugRef.current = null;
    editingCategoryRef.current = null;
    editingTagsRef.current = null;
    setCurrentId(null);
    setForm({ title: '', slug: '', excerpt: '', content: '', category: '', tags: '', cover: '', status: 'Published', type: 'Post', date: '', download: '', download_size: '', download_count: '', article_password: '', linked_product_sku: '', linked_product_url: '', linked_product_price: '' });
    setView('list');
  };

  const enterSiteTitleEditing = () => {
    if (siteTitleEditing || siteTitleSaving) return;
    siteTitleEditingBaseRef.current = siteTitle || '';
    setSiteTitleDraft(siteTitle || '');
    setSiteTitleEditing(true);
  };

  const exitSiteTitleEditing = () => {
    if (siteTitleSaving) return;
    setSiteTitleEditing(false);
    setSiteTitleDraft('');
  };

  const submitSiteTitle = async (rawTitle) => {
    const newTitle = String(rawTitle || '').trim();
    // 空值或与进入编辑时的快照相同：直接退出编辑态，不发请求
    if (!newTitle || newTitle === siteTitleEditingBaseRef.current) {
      exitSiteTitleEditing();
      return;
    }

    // 提交时查三日冷却配额，命中则留在编辑态（进入编辑态不查）
    try {
      const qRes = await fetch('/api/admin/config');
      const qData = await qRes.json().catch(() => null);
      if (qData?.success && qData.siteTitleQuota && !qData.siteTitleQuota.canChange) {
        alert('修改网站名称三日最多一次');
        return;
      }
    } catch (e) {
      /* 冷却查询失败不阻断，交由后端兜底 */
    }

    setLoading(true);
    setSavePhase('siteTitle');
    setSiteTitleSaving(true);
    try {
      const res = await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        alert('更改网站名称失败：' + (data?.error || res.status));
        return;
      }
      setSiteTitle(newTitle);
      siteTitleEditingBaseRef.current = newTitle;
      setSiteTitleEditing(false);
      setSiteTitleDraft('');

      // 首页立即刷新（快速标记，不预热等待）
      await triggerContentRevalidation({
        scope: 'batch',
        paths: ['/'],
        freshTheme: true,
        clearCaches: true,
      });

      // 其余页面入队后台异步刷新，不阻塞遮罩
      void triggerContentRevalidation({
        scope: 'site-config',
        queue: true,
        queuePriority: 0,
        queueDelayMs: 30000,
        queueReason: 'site-title',
        clearCaches: true,
      }).catch((e) => console.warn('全站标题刷新入队失败', e));

      showAdminToast('网站名称已更改，前台页面正在陆续刷新');
    } catch (e) {
      alert('更改网站名称失败：' + (e.message || '未知错误'));
    } finally {
      setLoading(false);
      setSavePhase('');
      setSiteTitleSaving(false);
    }
  };

  const submitSiteTitleFromDraft = () => {
    if (!siteTitleEditing || siteTitleSaving) return;
    void submitSiteTitle(siteTitleDraft);
  };

  const handleSiteTitleInputKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      exitSiteTitleEditing();
      return;
    }
    if (e.key !== 'Enter') return;
    // 中文输入法合成期间的 Enter 不触发保存
    if (e.nativeEvent?.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submitSiteTitleFromDraft();
  };

  const handleManualDeploy = () => {
    if (isThemeLoading || blogRefreshBusy) return;
    const now = Date.now();
    if (now < blogRefreshCooldownUntilRef.current) {
      const sec = Math.ceil((blogRefreshCooldownUntilRef.current - now) / 1000);
      showAdminToast(`刷新过于频繁，请 ${formatRefreshCooldownHint(sec)}后再试`);
      return;
    }
    setBlogRefreshBusy(true);
    showAdminToast('正在刷新 BLOG…');
    triggerShellBlogRefresh({ manualShell: true })
      .then((rev) => {
        if (rev.status === 429) {
          const retrySec = rev.data?.retryAfterSec || 60;
          blogRefreshCooldownUntilRef.current = Date.now() + retrySec * 1000;
          setBlogRefreshCooldownSec(retrySec);
          showAdminToast(rev.data?.error || `刷新过于频繁，请 ${formatRefreshCooldownHint(retrySec)}后再试`);
          return;
        }
        blogRefreshCooldownUntilRef.current = Date.now() + BLOG_SHELL_REFRESH_COOLDOWN_MS;
        setBlogRefreshCooldownSec(Math.ceil(BLOG_SHELL_REFRESH_COOLDOWN_MS / 1000));
        showRevalidateFeedback(rev, showAdminToast);
      })
      .catch((e) => console.warn('BLOG 刷新失败', e))
      .finally(() => { setBlogRefreshBusy(false); });
  };

  const handleCrawlerIngestRetry = async (queueId) => {
    if (crawlerIngestBusy || !queueId) return;
    try {
      const res = await fetch('/api/admin/crawler-ingest', {
        method: 'POST',
        headers: buildCrawlerIngestHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action: 'retry', id: queueId, tab: crawlerIngestTab }),
      });
      const data = await res.json();
      if (res.status === 403) {
        handleCrawlerIngestAuthError(data.error || '爬虫管理密码错误');
        return;
      }
      if (!res.ok || !data.success) throw new Error(data.error || '重试失败');
      applyCrawlerIngestPayload(data);
      showAdminToast('已重新加入待入库队列');
    } catch (e) {
      showAdminToast(e?.message || '重试失败');
    }
  };

  const handleCrawlerRetrySelected = async () => {
    if (crawlerIngestBusy) return; // P11-C3: 进行中早退
    if (!crawlerIngestSelectedIds.length) return;
    const count = crawlerIngestSelectedIds.length;
    try {
      const res = await fetch('/api/admin/crawler-ingest', {
        method: 'POST',
        headers: buildCrawlerIngestHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action: 'retry', ids: crawlerIngestSelectedIds }),
      });
      const data = await res.json();
      if (res.status === 403) {
        handleCrawlerIngestAuthError(data.error || '爬虫管理密码错误');
        return;
      }
      if (!res.ok || !data.success) throw new Error(data.error || '重试失败');
      applyCrawlerIngestPayload(data);
      setCrawlerIngestSelectedIds([]);
      showAdminToast(`已重新加入队列 ${data.retried ?? count} 条`);
    } catch (e) {
      showAdminToast(e?.message || '批量重试失败');
    }
  };

  const handleCrawlerReclaimStale = async () => {
    try {
      const res = await fetch('/api/admin/crawler-ingest', {
        method: 'POST',
        headers: buildCrawlerIngestHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action: 'reclaimStale', tab: 'processing' }),
      });
      const data = await res.json();
      if (res.status === 403) {
        handleCrawlerIngestAuthError(data.error || '爬虫管理密码错误');
        return;
      }
      if (!res.ok || !data.success) throw new Error(data.error || '纠正失败');
      applyCrawlerIngestPayload(data);
      const n = data.staleFailed ?? 0;
      showAdminToast(n > 0 ? `已将 ${n} 条超时任务标记为失败` : '暂无超时处理中任务');
    } catch (e) {
      showAdminToast(e?.message || '纠正失败');
    }
  };

  const handleCrawlerResetProcessingSelected = async () => {
    if (crawlerIngestBusy) return; // P11-C3: 进行中早退
    if (!crawlerIngestSelectedIds.length) return;
    try {
      const res = await fetch('/api/admin/crawler-ingest', {
        method: 'POST',
        headers: buildCrawlerIngestHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action: 'resetProcessing', ids: crawlerIngestSelectedIds }),
      });
      const data = await res.json();
      if (res.status === 403) {
        handleCrawlerIngestAuthError(data.error || '爬虫管理密码错误');
        return;
      }
      if (!res.ok || !data.success) throw new Error(data.error || '重置失败');
      applyCrawlerIngestPayload(data);
      setCrawlerIngestSelectedIds([]);
      showAdminToast(`已重置 ${data.reset ?? 0} 条为待入库`);
    } catch (e) {
      showAdminToast(e?.message || '重置失败');
    }
  };

  const handleSaveCrawlerAutoSettings = async ({ enabled, hour }) => {
    const res = await fetch('/api/admin/crawler-ingest', {
      method: 'POST',
      headers: buildCrawlerIngestHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ action: 'updateAutoSettings', enabled, hour }),
    });
    const data = await res.json();
    if (res.status === 403) {
      handleCrawlerIngestAuthError(data.error || '爬虫管理密码错误');
      return;
    }
    if (!res.ok || !data.success) throw new Error(data.error || '保存失败');
    if (data.autoSettings) setCrawlerIngestAutoSettings(data.autoSettings);
    if (data.summary) setCrawlerIngestSummary(data.summary);
    showAdminToast(
      data.autoSettings?.enabled
        ? `已启用每日 ${String(data.autoSettings.hour).padStart(2, '0')}:00（北京时间）自动入库`
        : '已关闭自动入库'
    );
  };

  const cancelCrawlerIngest = () => {
    crawlerIngestCancelRef.current = true;
    showAdminToast('正在停止入库…');
  };

  const ingestOneCrawlerRow = async (id, deferShellRefresh = true) => {
    const res = await fetchWithTimeout(
      '/api/admin/crawler-ingest',
      {
        method: 'POST',
        headers: buildCrawlerIngestHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          action: 'ingest',
          ids: [id],
          deferShellRefresh,
        }),
      },
      CRAWLER_INGEST_FETCH_TIMEOUT_MS
    );
    const data = await res.json();
    if (res.status === 403) {
      handleCrawlerIngestAuthError(data.error || '爬虫管理密码错误');
      return { ok: false, error: data.error || '爬虫管理密码错误', data };
    }
    if (!res.ok || !data.success) {
      return { ok: false, error: data.error || '爬虫入库失败', data };
    }
    applyCrawlerIngestPayload(data);
    const item = data.items?.[0];
    const succeeded =
      item?.status === 'done' ? 1 : data.succeeded > 0 ? data.succeeded : 0;
    const failed =
      item?.status === 'failed' ? 1 : data.failed > 0 ? data.failed : 0;
    return { ok: true, succeeded, failed, data };
  };

  const runCrawlerIngestLoop = async ({ mode, ids: explicitIds }) => {
    if (isThemeLoading || crawlerIngestBusy) {
      showAdminToast('入库任务进行中，请勿重复点击');
      return;
    }
    if (!crawlerIngestConfigured) {
      showAdminToast('爬虫入库服务尚未配置');
      return;
    }

    let initialPending = 0;
    if (mode === 'all') {
      const fresh = await fetchCrawlerIngestTab('pending');
      initialPending = fresh?.summary?.pending ?? fresh?.pendingItems?.length ?? 0;
    } else {
      initialPending = explicitIds?.length ?? 0;
    }

    if (initialPending <= 0) {
      showAdminToast(mode === 'all' ? '暂无待入库内容' : '请先选择待入库条目');
      return;
    }

    crawlerIngestCancelRef.current = false;
    setCrawlerIngestBusy(true);
    setCrawlerIngestProgress({
      initialPending,
      sessionSucceeded: 0,
      sessionFailed: 0,
      currentTitle: '',
      currentIndex: 0,
    });

    if (crawlerIngestPollRef.current) clearInterval(crawlerIngestPollRef.current);
    crawlerIngestPollRef.current = setInterval(() => {
      void fetchCrawlerIngestTab(crawlerIngestTab);
    }, CRAWLER_INGEST_POLL_MS);

    let sessionSucceeded = 0;
    let sessionFailed = 0;
    let currentIndex = 0;

    try {
      showAdminToast(
        mode === 'all'
          ? `开始逐条入库 ${initialPending} 条…`
          : `开始入库所选 ${initialPending} 条…`
      );

      if (mode === 'all') {
        while (!crawlerIngestCancelRef.current) {
          const data = await fetchCrawlerIngestTab('pending');
          const pending = data?.pendingItems ?? [];
          if (!pending.length) break;

          const row = pending[0];
          currentIndex += 1;
          setCrawlerIngestProgress((p) => ({
            ...p,
            currentTitle: row.title || row.slug || row.id,
            currentIndex,
          }));

          const result = await ingestOneCrawlerRow(row.id, true);
          if (!result.ok) {
            sessionFailed += 1;
            console.warn('crawler ingest row failed', row.id, result.error);
          } else {
            sessionSucceeded += result.succeeded;
            sessionFailed += result.failed;
          }

          setCrawlerIngestProgress((p) => ({
            ...p,
            sessionSucceeded,
            sessionFailed,
          }));
        }
      } else {
        const workIds = [...explicitIds];
        const titleMap = {};
        for (const r of crawlerIngestPendingList) {
          if (workIds.includes(r.id)) titleMap[r.id] = r.title || r.slug;
        }
        for (const r of crawlerIngestFailedList) {
          if (workIds.includes(r.id)) titleMap[r.id] = r.title || r.slug;
        }

        for (const id of workIds) {
          if (crawlerIngestCancelRef.current) break;

          currentIndex += 1;
          setCrawlerIngestProgress((p) => ({
            ...p,
            currentTitle: titleMap[id] || id,
            currentIndex,
          }));

          const result = await ingestOneCrawlerRow(id, true);
          if (!result.ok) {
            sessionFailed += 1;
            console.warn('crawler ingest row failed', id, result.error);
          } else {
            sessionSucceeded += result.succeeded;
            sessionFailed += result.failed;
          }

          setCrawlerIngestProgress((p) => ({
            ...p,
            sessionSucceeded,
            sessionFailed,
          }));
        }
      }

      await fetchPosts();
      if (sessionSucceeded > 0) {
        const rev = await triggerShellBlogRefresh({ contentChange: true });
        if (rev?.error) console.warn('壳层刷新失败', rev.error);
      }

      const cancelled = crawlerIngestCancelRef.current;
      showAdminToast(
        cancelled
          ? `已停止：本次成功 ${sessionSucceeded}，失败 ${sessionFailed}`
          : `入库结束：本次成功 ${sessionSucceeded}，失败 ${sessionFailed}`
      );
      await fetchCrawlerIngestTab(crawlerIngestTab);
    } catch (e) {
      showAdminToast(e?.message || '爬虫入库失败');
      await fetchCrawlerIngestTab(crawlerIngestTab);
    } finally {
      if (crawlerIngestPollRef.current) {
        clearInterval(crawlerIngestPollRef.current);
        crawlerIngestPollRef.current = null;
      }
      setCrawlerIngestBusy(false);
      setCrawlerIngestProgress(null);
      setCrawlerIngestSelectedIds([]);
      crawlerIngestCancelRef.current = false;
    }
  };

  const handleCrawlerIngestAll = async () => {
    await runCrawlerIngestLoop({ mode: 'all' });
  };

  const handleCrawlerIngestSelected = async () => {
    await runCrawlerIngestLoop({
      mode: 'selected',
      ids: [...crawlerIngestSelectedIds],
    });
  };

  const handleCrawlerQueueDeleteSelected = async () => {
    if (crawlerIngestBusy) return; // P11-C3: 进行中早退
    if (!crawlerIngestSelectedIds.length) return;
    if (!confirm(`从队列删除 ${crawlerIngestSelectedIds.length} 条待入库元数据？`)) return;
    try {
      const res = await fetch('/api/admin/crawler-ingest', {
        method: 'POST',
        headers: buildCrawlerIngestHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action: 'delete', ids: crawlerIngestSelectedIds }),
      });
      const data = await res.json();
      if (res.status === 403) {
        handleCrawlerIngestAuthError(data.error || '爬虫管理密码错误');
        return;
      }
      if (!res.ok || !data.success) throw new Error(data.error || '删除失败');
      applyCrawlerIngestPayload(data);
      setCrawlerIngestSelectedIds([]);
      showAdminToast(`已删除 ${data.deleted ?? 0} 条队列记录`);
    } catch (e) {
      showAdminToast(e?.message || '删除失败');
    }
  };

  const deleteTagOption = (e, tagToDelete) => {
    e.stopPropagation();
    const currentTags = form.tags ? form.tags.split(',').filter(t => t.trim()) : [];
    const newTags = currentTags.filter(t => t.trim() !== tagToDelete).join(',');
    setFormDirty({ ...form, tags: newTags });
  };

  const handleNavClick = (idx) => { setNavIdx(idx); const modes = ['folder','covered','text','gallery']; setViewMode(modes[idx]); setSelectedFolder(null); };

  const editingSimplePage = isSimpleCustomPage(form?.slug);

  const sortAdminPosts = (list) => {
    return [...list].sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return String(b.date || '').localeCompare(String(a.date || ''));
    });
  };

  const handleTogglePin = async (e, p) => {
    e.stopPropagation();
    if (pinBusyId === p.id) return;
    const nextPinned = !p.pinned;
    setPinBusyId(p.id);
    setLoading(true);
    try {
      const r = await fetch('/api/admin/post?id=' + p.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: nextPinned }),
      });
      const d = await r.json();
      if (!d.success) alert(d.error || '置顶操作失败');
      else {
        await fetchPosts();
        const rev = await triggerContentRevalidation({
          scope: 'post',
          slug: p.slug,
          category: p.category || '',
          tags: p.tags || '',
          queue: true,
          queueDelayMs: 30_000,
          clearCaches: true,
          contentChange: true,
          queueReason: 'pin-toggle',
          queuePriority: 10,
        });
        showRevalidateFeedback(rev, showAdminToast);
      }
    } catch (err) {
      alert(err.message || '置顶操作失败');
    } finally {
      setPinBusyId(null);
      setLoading(false);
    }
  };

  const handleToggleFavourite = async (e, p) => {
    e.stopPropagation();
    if (favouriteBusyId === p.id) return;
    const nextFavourited = !p.favourited;
    setFavouriteBusyId(p.id);
    try {
      const r = await fetch('/api/admin/post?id=' + p.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favourited: nextFavourited }),
      });
      const d = await r.json();
      if (!d.success) {
        showAdminToast(d.error || '收藏操作失败', 2000);
        return;
      }
      setPosts((prev) =>
        prev.map((item) =>
          item.id === p.id ? { ...item, favourited: nextFavourited } : item
        )
      );
      showAdminToast(nextFavourited ? '收藏成功' : '已取消收藏', 2000);
      fetchPosts({ silent: true });
    } catch (err) {
      showAdminToast(err.message || '收藏操作失败', 2000);
    } finally {
      setFavouriteBusyId(null);
    }
  };

  const runListMutation = (options) =>
    executeListMutationWithProgress({
      ...options,
      setLoading,
      setSavePhase,
      setSaveProgress,
      fetchPostsFn: fetchPosts,
    });

  const handleDeletePost = async (p) => {
    if (archivingPostIds.includes(p.id)) return; // P11-C3: 进行中早退
    if (!confirm('移至回收站')) return;
    setArchivingPostIds((currentIds) => [...currentIds, p.id]);

    try {
      const res = await fetch('/api/admin/post?id=' + p.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: p.id, type: 'Piece' }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || '移入回收站失败');
      }

      pendingPostTypeOverridesRef.current.set(p.id, 'Piece');
      setPosts((currentPosts) =>
        currentPosts.map((post) =>
          post.id === p.id ? { ...post, type: 'Piece' } : post
        )
      );
      showAdminToast('已移到回收站，前台缓存将在后台更新');
      void triggerShellBlogRefresh({
        contentChange: true,
        queue: true,
        queueDelayMs: 30_000,
        queueReason: 'archive-post',
        queuePriority: 10,
      }).catch((e) => console.warn('归档后列表刷新失败', e));
      void triggerContentRevalidation({
        scope: 'delete',
        slug: p.slug,
        category: p.category || '',
        tags: p.tags || '',
        queue: true,
        queueDelayMs: 30_000,
        clearCaches: true,
        contentChange: true,
        queueReason: 'archive-post-detail',
        queuePriority: 10,
      }).catch((e) => console.warn('归档后页面刷新失败', e));
    } catch (e) {
      alert('移入回收站失败：' + (e.message || '未知错误'));
    } finally {
      setArchivingPostIds((currentIds) => currentIds.filter((id) => id !== p.id));
    }
  };

  const handleRestorePost = async (p) => {
    pendingPostTypeOverridesRef.current.set(p.id, 'Post');
    try {
      const rev = await runListMutation({
        phase: 'restore',
        itemCount: 1,
        shellRefreshOptions: {
          contentChange: true,
          queue: true,
          queueDelayMs: 30_000,
          queueReason: 'restore-post',
          queuePriority: 10,
        },
        mutateItems: async (report) => {
          report(0, '正在恢复文章…');
          const res = await fetch('/api/admin/post?id=' + p.id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: p.id, type: 'Post' }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || '恢复失败');
          }
          report(1, '已更新文章状态');
        },
        afterRefresh: async () => {
          void triggerContentRevalidation({
            scope: 'post',
            slug: p.slug,
            category: p.category || '',
            tags: p.tags || '',
            queue: true,
            queueDelayMs: 30_000,
            clearCaches: true,
            contentChange: true,
            queueReason: 'restore-post-detail',
            queuePriority: 10,
          }).catch((e) => console.warn('恢复后页面刷新失败', e));
        },
      });
      showRevalidateFeedback(rev, showAdminToast);
      showAdminToast('已恢复文章');
    } catch (e) {
      pendingPostTypeOverridesRef.current.delete(p.id);
      alert('恢复失败：' + (e.message || '未知错误'));
    }
  };

  const handlePermanentDeletePost = async (p) => {
    if (!confirm('彻底删除？此操作不可恢复。')) return;
    pendingPostTypeOverridesRef.current.delete(p.id);
    try {
      const rev = await runListMutation({
        phase: 'delete',
        itemCount: 1,
        shellRefreshOptions: {
          contentChange: true,
          queue: true,
          queueDelayMs: 30_000,
          queueReason: 'permanent-delete',
          queuePriority: 10,
        },
        mutateItems: async (report) => {
          report(0, '正在彻底删除…');
          const res = await fetch('/api/admin/post?id=' + p.id, { method: 'DELETE' });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || '删除失败');
          }
          report(1, '已从数据库移除');
        },
      });
      showRevalidateFeedback(rev, showAdminToast);
      showAdminToast('已彻底删除');
    } catch (e) {
      alert('删除失败：' + (e.message || '未知错误'));
    }
  };

  const togglePostSelection = (postId) => {
    setSelectedPostIds((prev) =>
      prev.includes(postId) ? prev.filter((id) => id !== postId) : [...prev, postId]
    );
  };

  const handleListSelectButtonClick = () => {
    if (view === 'recycle') {
      if (listSelectMode && selectedPostIds.length > 0) {
        handleBulkPermanentDelete();
        return;
      }
      if (listSelectMode) {
        setListSelectMode(false);
        setSelectedPostIds([]);
        return;
      }
      setListSelectMode(true);
      setSelectedPostIds([]);
      return;
    }
    if (listSelectMode && selectedPostIds.length > 0) {
      handleBulkArchivePosts();
      return;
    }
    if (listSelectMode) {
      setListSelectMode(false);
      setSelectedPostIds([]);
      return;
    }
    setListSelectMode(true);
    setSelectedPostIds([]);
  };

  // 取消选择：清空已选并直接退出多选模式
  const handleClearSelection = () => {
    setSelectedPostIds([]);
    setListSelectMode(false);
  };

  const handleBulkArchivePosts = async () => {
    const ids = [...selectedPostIds];
    if (!ids.length) return;
    if (!confirm(`将 ${ids.length} 篇文章移到回收站？`)) return;
    const archived = posts.filter((p) => ids.includes(p.id));
    let ok = 0;
    let fail = 0;
    try {
      const rev = await runListMutation({
        phase: 'archive',
        itemCount: ids.length,
        shellRefreshOptions: { contentChange: true },
        mutateItems: async (report) => {
          for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            report(i, `正在移入回收站 ${i + 1}/${ids.length} 篇…`);
            const res = await fetch('/api/admin/post?id=' + id, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id, type: 'Piece' }),
            });
            const data = await res.json();
            if (res.ok && data.success) {
              ok += 1;
              pendingPostTypeOverridesRef.current.set(id, 'Piece');
            } else {
              fail += 1;
            }
            report(i + 1, `已处理 ${i + 1}/${ids.length} 篇`);
          }
        },
        afterRefresh: async () => {
          for (const p of archived) {
            void triggerContentRevalidation({
              scope: 'delete',
              slug: p.slug,
              category: p.category || '',
              tags: p.tags || '',
            }).catch((e) => console.warn('归档后页面刷新失败', e));
          }
        },
      });
      showRevalidateFeedback(rev, showAdminToast);
      setListSelectMode(false);
      setSelectedPostIds([]);
      if (fail > 0) showAdminToast(`已移入回收站 ${ok} 篇，失败 ${fail} 篇`);
      else showAdminToast(`已移入回收站 ${ok} 篇`);
    } catch (e) {
      alert('批量移入回收站失败：' + (e.message || '未知错误'));
    }
  };

  const handleBulkPermanentDelete = async () => {
    const ids = [...selectedPostIds];
    if (!ids.length) return;
    if (!confirm(`彻底删除 ${ids.length} 篇文章？此操作不可恢复。`)) return;
    ids.forEach((id) => pendingPostTypeOverridesRef.current.delete(id));
    let ok = 0;
    let fail = 0;
    try {
      const rev = await runListMutation({
        phase: 'delete',
        itemCount: ids.length,
        mutateItems: async (report) => {
          for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            report(i, `正在彻底删除 ${i + 1}/${ids.length} 篇…`);
            const res = await fetch('/api/admin/post?id=' + id, { method: 'DELETE' });
            const data = await res.json();
            if (res.ok && data.success) ok += 1;
            else fail += 1;
            report(i + 1, `已处理 ${i + 1}/${ids.length} 篇`);
          }
        },
      });
      showRevalidateFeedback(rev, showAdminToast);
      setListSelectMode(false);
      setSelectedPostIds([]);
      if (fail > 0) showAdminToast(`已彻底删除 ${ok} 篇，失败 ${fail} 篇`);
      else showAdminToast(`已彻底删除 ${ok} 篇`);
    } catch (e) {
      alert('批量删除失败：' + (e.message || '未知错误'));
    }
  };

  const handlePostCardClick = (p) => {
    if (view === 'recycle' && listSelectMode) {
      togglePostSelection(p.id);
      return;
    }
    if (listSelectMode && activeTab === 'Post') {
      togglePostSelection(p.id);
      return;
    }
    handlePreview(p);
  };

  const renderPostSelectMark = (postId) => {
    if (!listSelectMode) return null;
    if (view !== 'recycle' && activeTab !== 'Post') return null;
    const checked = selectedPostIds.includes(postId);
    return (
      <div className={`admin-card-select-mark${checked ? ' is-checked' : ''}`} aria-hidden>
        {checked ? '✓' : ''}
      </div>
    );
  };

  /** 文章卡片元信息上的分类 chip：点击弹开快速改分类下拉 */
  const renderCardCategoryChip = (p) => (
    <button
      type="button"
      className="card-cat-chip"
      onClick={(e) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        setCardCatMenuRect({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 180) });
        setCardCatOpenId(p.id);
      }}
      title="点击更改分类"
    >
      <span className={`card-cat-chip-text${(p.category || '').trim() ? '' : ' is-uncat'}`}>
        {(p.category || '').trim() || '未分类'}
      </span>
      <Icons.ChevronDown />
    </button>
  );

  const renderCardDrawer = (p, { showPin = false } = {}) => {
    if (listSelectMode && activeTab === 'Post') return null;
    return (
    <div className="drawer">
      {showPin ? (
        <div
          onClick={(e) => handleTogglePin(e, p)}
          disabled={pinBusyId === p.id}
          style={{
            background: pinBusyId === p.id ? '#4a4a50' : (p.pinned ? '#fbbf24' : '#5c5c62'),
            color: p.pinned && pinBusyId !== p.id ? '#000' : '#fff',
          }}
          className={`dr-btn${pinBusyId === p.id ? ' is-loading' : ''}`}
          title={p.pinned ? '取消置顶' : '置顶（博客首页首条显示）'}
        >
          {pinBusyId === p.id ? (
            <span className="dr-btn-spin" aria-hidden />
          ) : (
            <Icons.Pin />
          )}
        </div>
      ) : null}
      {showPin ? (
        <div
          onClick={(e) => handleToggleFavourite(e, p)}
          style={{
            background: favouriteBusyId === p.id ? '#4a4a50' : (p.favourited ? '#fbbf24' : '#5c5c62'),
            color: p.favourited && favouriteBusyId !== p.id ? '#000' : '#fff',
          }}
          className={`dr-btn${favouriteBusyId === p.id ? ' is-loading' : ''}`}
          title={p.favourited ? '取消收藏' : '收藏（在「已收藏」标签中查看）'}
        >
          {favouriteBusyId === p.id ? (
            <span className="dr-btn-spin" aria-hidden />
          ) : (
            <Icons.Star filled={!!p.favourited} />
          )}
        </div>
      ) : null}
      <div onClick={(e) => { e.stopPropagation(); handleEdit(p); }} style={{ background: 'greenyellow', color: '#000' }} className="dr-btn"><Icons.Edit /></div>
      <div onClick={(e) => { e.stopPropagation(); handleDeletePost(p); }} style={{ background: '#ff4d4f' }} className="dr-btn" title="移到回收站"><Icons.Trash /></div>
    </div>
    );
  };

  const renderRecycleCardDrawer = (p) => (
    <div className="drawer">
      <div
        onClick={(e) => { e.stopPropagation(); handleRestorePost(p); }}
        style={{ background: 'greenyellow', color: '#000' }}
        className="dr-btn"
        title="恢复文章"
      >
        <Icons.Restore />
      </div>
      <div
        onClick={(e) => { e.stopPropagation(); handlePermanentDeletePost(p); }}
        style={{ background: '#ff4d4f' }}
        className="dr-btn"
        title="彻底删除"
      >
        <Icons.Trash />
      </div>
    </div>
  );

  const getFilteredPosts = () => {
     let list = archivingPostIds.length > 0
       ? posts.filter((post) => !archivingPostIds.includes(post.id))
       : posts;
     if (activeTab === 'Page') {
        list = list.filter(p =>
          (p.type === 'Page' && ['about', 'download'].includes(p.slug)) ||
          (p.type === 'Post' && p.slug === ANNOUNCEMENT_SLUG)
        );
        const ann = list.find(p => p.slug === ANNOUNCEMENT_SLUG);
        const rest = list.filter(p => p.slug !== ANNOUNCEMENT_SLUG);
        list = ann ? [ann, ...rest] : rest;
     }
     else if (activeTab === 'Widget' || activeTab === 'Ads') {
        list = [];
     }
     else if (activeTab === 'Favourites') {
        list = list.filter(p =>
          p.type === 'Post' &&
          p.status !== 'Draft' &&
          p.slug !== ANNOUNCEMENT_SLUG &&
          p.favourited
        );
        list = sortAdminPosts(list);
     }
     else {
        list = list.filter(p => p.type === 'Post' && p.status !== 'Draft' && p.slug !== ANNOUNCEMENT_SLUG);
        list = sortAdminPosts(list);
     }

     if (searchQuery) list = list.filter(p => p.title.toLowerCase().includes(searchQuery.toLowerCase()));
      if (selectedFolder) {
        if (selectedFolder === FALLBACK_CATEGORY) {
          list = list.filter((p) => !(p.category || '').trim() || p.category === FALLBACK_CATEGORY);
        } else {
          list = list.filter((p) => p.category === selectedFolder);
        }
      }
     if (selectedPublishDate && activeTab === 'Post') {
       list = list.filter(p => toDateKey(p.date) === selectedPublishDate);
     }
     return list;
  };
  const filtered = getFilteredPosts();
  const syncingNewPostTitles = Array.from(new Set([
    ...publishQueue
      .filter((job) =>
        (job.status === 'queued' || job.status === 'running') &&
        !job.payload?.currentId &&
        !job.payload?.isWidget &&
        (job.payload?.form?.type || 'Post') === 'Post'
      )
      .map((job) => job.title),
    ...pendingPostSyncs.map((item) => item.title),
  ]));
  const recyclePosts = (() => {
    let list = posts.filter((p) => p.type === 'Piece');
    if (searchQuery) {
      list = list.filter((p) =>
        p.title.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }
    return list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  })();
  const recycleAllSelected =
    recyclePosts.length > 0 &&
    recyclePosts.every((p) => selectedPostIds.includes(p.id));
  const toggleRecycleSelectAll = () => {
    const allIds = recyclePosts.map((p) => p.id);
    if (!allIds.length) return;
    setSelectedPostIds(recycleAllSelected ? [] : allIds);
  };
  const recycleCount = posts.filter((p) => p.type === 'Piece').length;
  const publishedPostCount = posts.filter(
    (p) =>
      p.type === 'Post' &&
      p.status !== 'Draft' &&
      p.slug !== ANNOUNCEMENT_SLUG
  ).length;
  const favouritedPostCount = posts.filter(
    (p) =>
      p.type === 'Post' &&
      p.status !== 'Draft' &&
      p.slug !== ANNOUNCEMENT_SLUG &&
      p.favourited
  ).length;
  const siteInfoWidget = posts.find(p => p.type === 'Widget' && !['gallery-ad', 'vending', 'announcement-popup', 'popup-ad', 'click-ad', 'social-links', 'banner'].includes(p.slug));
  const pinnedDividerIndex = activeTab === 'Post' ? filtered.findIndex(p => !p.pinned) : -1;
  const publishDatesSet = (() => {
    const s = new Set();
    posts
      .filter(p => p.type === 'Post' && p.status !== 'Draft' && p.slug !== ANNOUNCEMENT_SLUG)
      .forEach(p => {
        const k = toDateKey(p.date);
        if (k) s.add(k);
      });
    return s;
  })();
  const categoryFolderList = (() => {
    const set = new Set(
      (options.categories || []).filter((c) => !isProtectedCategory(c))
    );
    set.add(FALLBACK_CATEGORY);
    return [...set].sort((a, b) => {
      if (a === FALLBACK_CATEGORY) return -1;
      if (b === FALLBACK_CATEGORY) return 1;
      return a.localeCompare(b, 'zh-CN');
    });
  })();
  const displayTags = (options.tags && options.tags.length > 0) ? (showAllTags ? options.tags : options.tags.slice(0, 12)) : [];
  const selectedTags = (form.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  const addTag = (name) => { const n = (name || '').trim(); if (!n || selectedTags.includes(n)) return; setFormDirty({ ...form, tags: [...selectedTags, n].join(',') }); };
  const removeTag = (name) => { setFormDirty({ ...form, tags: selectedTags.filter(t => t !== name).join(',') }); };
  const setCategory = (name) => {
    const n = (name || '').trim();
    if (!n) {
      setFormDirty((f) => ({ ...f, category: '' }));
      return;
    }
    if (isProtectedCategory(n)) return;
    setFormDirty({ ...form, category: n });
    setOptions(o => ({
      ...o,
      categories: o.categories.includes(n) ? o.categories : [...o.categories, n].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    }));
  };
  const addCategoryFromDraft = () => {
    const n = catDraft.trim();
    if (n && !isProtectedCategory(n)) setCategory(n);
    setCatDraft('');
    setShowCatInput(false);
  };

  const runTaxonomyDelete = (type, name) => {
    const n = (name || '').trim();
    if (!n) return;
    fetch('/api/admin/taxonomy', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, name: n }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) {
          showAdminToast(d.error || '删除失败', 2000);
          fetchPosts({ silent: true });
        }
      })
      .catch(() => {
        showAdminToast('删除失败，请稍后重试', 2000);
        fetchPosts({ silent: true });
      });
  };

  const permanentlyDeleteCategory = (name) => {
    const n = (name || '').trim();
    if (!n || isSystemReservedCategory(n)) return;
    setOptions((o) => ({
      ...o,
      categories: [...new Set([...o.categories.filter((c) => c !== n), FALLBACK_CATEGORY])].sort((a, b) =>
        a.localeCompare(b, 'zh-CN')
      ),
    }));
    if ((form.category || '').trim() === n) {
      setFormDirty((f) => ({ ...f, category: FALLBACK_CATEGORY }));
    }
    setPosts((prev) =>
      prev.map((p) => (p.category === n ? { ...p, category: FALLBACK_CATEGORY } : p))
    );
    if (selectedFolder === n) setSelectedFolder(FALLBACK_CATEGORY);
    showAdminToast(`已删除分类「${n}」，相关文章已归入「${FALLBACK_CATEGORY}」`, 2000);
    runTaxonomyDelete('category', n);
  };

  /** 卡片分类 chip 快速改分类：乐观更新 + PATCH + 失败回滚刷新 */
  const handleCardCategoryPick = (postId, value) => {
    const nv = (value || '').trim();
    const prev = posts.find((p) => p.id === postId);
    if (!prev) return;
    if ((prev.category || '') === nv) { setCardCatOpenId(null); setCardCatMenuRect(null); return; }
    // 乐观更新
    setPosts((ps) => ps.map((p) => (p.id === postId ? { ...p, category: nv } : p)));
    if (nv) {
      setOptions((o) => ({
        ...o,
        categories: o.categories.includes(nv) ? o.categories : [...o.categories, nv].sort((a, b) => a.localeCompare(b, 'zh-CN')),
      }));
    }
    setCardCatOpenId(null); setCardCatMenuRect(null);
    fetch('/api/admin/post', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: postId, category: nv }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          showAdminToast(nv ? `已将文章分类改为「${nv}」` : '已清除文章分类', 2000);
        } else {
          showAdminToast(d.error || '分类更新失败', 2000);
          fetchPosts({ silent: true });
        }
      })
      .catch(() => { showAdminToast('分类更新失败，请稍后重试', 2000); fetchPosts({ silent: true }); });
  };

  const requestDeleteCategory = (name) => {
    const n = (name || '').trim();
    if (!n || isSystemReservedCategory(n)) return;
    setTaxonomyConfirmName(n);
    setTaxonomyConfirmClosing(false);
    setTaxonomyConfirmOpen(true);
  };

  const runTaxonomyRename = (oldName, newName) => {
    fetch('/api/admin/taxonomy', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'category', oldName, newName }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) {
          showAdminToast(d.error || '重命名失败', 2000);
          fetchPosts({ silent: true });
        }
      })
      .catch(() => {
        showAdminToast('重命名失败，请稍后重试', 2000);
        fetchPosts({ silent: true });
      });
  };

  const renameCategory = (oldName, newName) => {
    const from = (oldName || '').trim();
    const to = (newName || '').trim();
    if (!from || !to || from === to) return;
    if (isSystemReservedCategory(from) || isSystemReservedCategory(to)) return;
    if (options.categories.some((c) => c === to && c !== from)) {
      showAdminToast(`分类「${to}」已存在`, 2000);
      return;
    }
    setOptions((o) => ({
      ...o,
      categories: [...new Set(o.categories.map((c) => (c === from ? to : c)))].sort((a, b) =>
        a.localeCompare(b, 'zh-CN')
      ),
    }));
    if ((form.category || '').trim() === from) {
      setFormDirty((f) => ({ ...f, category: to }));
    }
    if (selectedFolder === from) setSelectedFolder(to);
    setPosts((prev) =>
      prev.map((p) => (p.category === from ? { ...p, category: to } : p))
    );
    showAdminToast(`分类已重命名为「${to}」`, 2000);
    runTaxonomyRename(from, to);
  };

  const permanentlyDeleteTag = (name) => {
    const n = (name || '').trim();
    if (!n) return;
    setOptions((o) => ({
      ...o,
      tags: o.tags.filter((t) => t !== n),
    }));
    const currentTags = (form.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
    if (currentTags.includes(n)) {
      setFormDirty((f) => ({
        ...f,
        tags: currentTags.filter((t) => t !== n).join(','),
      }));
    }
    setPosts((prev) =>
      prev.map((p) => {
        if (!p.tags) return p;
        const tags = p.tags.split(',').map((t) => t.trim()).filter(Boolean);
        if (!tags.includes(n)) return p;
        return { ...p, tags: tags.filter((t) => t !== n).join(',') };
      })
    );
    showAdminToast(`已删除标签「${n}」`, 2000);
    runTaxonomyDelete('tag', n);
  };

  const handlePublishDateSelect = (key) => {
    if (key == null) {
      setSelectedPublishDate(null);
      return;
    }
    setSelectedPublishDate(prev => (prev === key ? null : key));
    setDatePickerOpen(false);
  };

  if (!mounted) return null;

  const adminLocked = isThemeLoading;

  return (
    <div style={{ minHeight: '100vh', background: '#303030', padding: '40px 20px' }}>
      <Head>
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="shortcut icon" href="/favicon-32x32.png" />
      </Head>
      <GlobalStyle />
      {loading && !isThemeLoading && <FullScreenLoader phase={savePhase} progress={saveProgress} />}
      {isThemeLoading && <FullScreenLoader phase="theme" progress={themeSwitchProgress} />}
      <CoverMissingModal
        open={coverModalOpen}
        closing={coverModalClosing}
        onConfirm={confirmCoverAndSave}
        onCancel={closeCoverModal}
      />
      <PublishConfirmModal
        open={publishConfirmOpen}
        closing={publishConfirmClosing}
        isUpdate={!!currentId}
        publishAs={publishAs}
        onPublishAsChange={setPublishAs}
        showModeOptions={formIsPostArticle}
        onConfirm={proceedPublishAfterConfirm}
        onCancel={closePublishConfirmModal}
      />
      <LeaveConfirmModal
        open={leaveConfirmOpen}
        onLeave={leaveConfirmLeaveAnyway}
        onStay={closeLeaveConfirm}
        onSaveDraft={leaveConfirmSaveDraft}
        canSaveDraft={formIsPostArticle}
      />
      <TaxonomyConfirmModal
        open={taxonomyConfirmOpen}
        closing={taxonomyConfirmClosing}
        categoryName={taxonomyConfirmName}
        onConfirm={confirmTaxonomyDelete}
        onCancel={closeTaxonomyConfirmModal}
      />
      <ThemeSwitchDoneModal
        open={themeDoneModalOpen}
        closing={themeDoneModalClosing}
        extraNote={themeDoneModalNote}
        onClose={closeThemeDoneModal}
      />
      <CrawlerIngestUnlockModal
        open={crawlerIngestUnlockOpen}
        closing={crawlerIngestUnlockClosing}
        busy={crawlerIngestUnlockBusy}
        passwordError={crawlerIngestUnlockError}
        onConfirm={confirmCrawlerIngestUnlock}
        onCancel={closeCrawlerIngestUnlockModal}
      />
      <VendingAddressUnlockModal
        open={vendingAddressUnlockOpen}
        closing={vendingAddressUnlockClosing}
        busy={vendingAddressUnlockBusy}
        passwordError={vendingAddressUnlockError}
        onConfirm={confirmVendingAddressUnlock}
        onCancel={closeVendingAddressUnlockModal}
      />
      <AdminToast message={adminToast.message} visible={adminToast.visible} closing={adminToast.closing} />
      <PublishQueuePanel
        jobs={publishQueue}
        onRetry={retryJob}
        onRetryFromPhase={retryJobFromPhase}
        onRestoreToEditor={restoreJobToEditor}
        onRemove={removeJob}
        onForceComplete={forceCompleteJob}
      />
      <div className="admin-shell" style={{ maxWidth: 900, margin: '0 auto', opacity: adminLocked ? 0.45 : 1, pointerEvents: adminLocked ? 'none' : 'auto', transition: 'opacity 0.25s ease' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
           <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
             {(view === 'list' || view === 'recycle') && <SearchInput value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />}
             <div style={{display:'flex', flexDirection:'column', justifyContent:'center'}}>
                  <div style={{ fontSize: '24px', fontWeight: '900', letterSpacing: '1px', display:'flex', alignItems:'center', gap:'10px' }}>
                     {siteTitleEditing ? (
                       <>
                         <input
                           autoFocus
                           className="glow-input"
                           aria-label="网站标题"
                           value={siteTitleDraft}
                           size={Math.max(16, (siteTitleDraft || '').length + 2)}
                           style={{ width: 'auto', minWidth: 200, maxWidth: 560, flexShrink: 0, fontSize: '18px', fontWeight: '800', padding: '6px 10px', letterSpacing: '0.5px' }}
                           onFocus={(e) => { const len = e.target.value.length; try { e.target.setSelectionRange(len, len); } catch (err) {} }}
                           onChange={(e) => setSiteTitleDraft(e.target.value)}
                           onKeyDown={handleSiteTitleInputKeyDown}
                         />
                         <button
                           type="button"
                           onClick={submitSiteTitleFromDraft}
                           disabled={siteTitleSaving}
                           style={{ flexShrink: 0, background: '#fff', color: '#111', border: 'none', padding: '7px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: 'bold', cursor: siteTitleSaving ? 'not-allowed' : 'pointer', opacity: siteTitleSaving ? 0.6 : 1 }}
                         >
                           保存修改
                         </button>
                         <button
                           type="button"
                           onClick={exitSiteTitleEditing}
                           disabled={siteTitleSaving}
                           style={{ flexShrink: 0, background: '#2a2a2e', color: '#ccc', border: '1px solid #555', padding: '6px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: 'bold', cursor: siteTitleSaving ? 'not-allowed' : 'pointer' }}
                         >
                           取消
                         </button>
                       </>
                     ) : (
                       <span onClick={enterSiteTitleEditing} style={{cursor:'pointer'}} title="点击修改网站名称">{siteTitle}</span>
                     )}
                     {/* P18FREEPRO: 标识色(专业版金VIP/免费版浅绿,用户2026-08-30) */}
                     {sitePlan === 'pro' ? (
                       <span style={{fontSize:'10.5px', padding:'2px 8px', borderRadius:'999px', background:'rgba(251,191,36,0.12)', color:'#fbbf24', border:'1px solid rgba(251,191,36,0.5)', fontWeight:'normal', whiteSpace:'nowrap'}}>VIP · 专业版</span>
                     ) : sitePlan === 'free' ? (
                       <span style={{fontSize:'10.5px', padding:'2px 8px', borderRadius:'999px', background:'rgba(173,255,47,0.10)', color:'#9acd32', border:'1px solid rgba(173,255,47,0.4)', fontWeight:'normal', whiteSpace:'nowrap'}}>免费版</span>
                     ) : null}
                     <AdminGearMenu
                       wrapRef={headerActionsMenuRef}
                       open={headerActionsMenuOpen}
                       onToggle={() => setHeaderActionsMenuOpen((v) => !v)}
                       onClose={() => setHeaderActionsMenuOpen(false)}
                       isThemeLoading={isThemeLoading}
                       crawlerIngestBusy={crawlerIngestBusy}
                       crawlerIngestProgress={crawlerIngestProgress}
                       crawlerIngestConfigured={crawlerIngestConfigured}
                       crawlerIngestSummary={crawlerIngestSummary}
                       onOpenIngestList={openCrawlerIngestView}
                       onShowOnboarding={() => showAdminToast('新手引导即将上线')}
                     />
                  </div>
             </div>
           </div>
           
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexShrink: 0 }}>
              {view !== 'drafts' && (
                <button
                  type="button"
                  onClick={() => (view === 'edit' ? guardLeaveEditor(openDraftsView) : openDraftsView())}
                  title="草稿"
                  className="admin-top-action-btn"
                >
                  草稿箱
                </button>
               )}
                <AdminRefreshButton
                  isThemeLoading={isThemeLoading}
                  blogRefreshBusy={blogRefreshBusy}
                  blogRefreshCooldownSec={blogRefreshCooldownSec}
                  onShellRefresh={handleManualDeploy}
                />
              {view === 'list' ? (
                <AnimatedBtn text="发布新内容" onClick={handleCreate} />
              ) : (
                <AnimatedBtn
                  text="返回列表"
                  onClick={() =>
                    view === 'crawler-ingest'
                      ? leaveCrawlerIngestView()
                      : view === 'recycle'
                        ? leaveRecycleView()
                        : guardLeaveEditor(leaveEditView)
                  }
                />
              )}
           </div>
        </header>

{view === 'list' ? (
          <main>
            <GalleryStorageBar
              stats={galleryStorageStats}
              loading={galleryStorageLoading}
              error={galleryStorageError}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', gap: '12px' }}>
              <div className="admin-list-head-left">
                {/* 1. 分类标签组 */}
                <div className="admin-list-tabs">
                  {['Post', 'Favourites', 'Widget', 'Ads', 'Page'].map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => { setActiveTab(t); setSelectedFolder(null); setSelectedPublishDate(null); setDatePickerOpen(false); }}
                      className={`admin-list-tab${activeTab === t ? ' is-active' : ''}`}
                    >
                      {t === 'Page' ? (
                        '自定义页面'
                      ) : t === 'Post' ? (
                        <>
                          已发布
                          <span
                            className={`admin-list-tab-count${activeTab === t ? ' is-published' : ' is-published-idle'}`}
                          >
                            {publishedPostCount}
                          </span>
                        </>
                      ) : t === 'Favourites' ? (
                        <>
                          已收藏
                          <span
                            className={`admin-list-tab-count${activeTab === t ? ' is-favourites' : ' is-favourites-idle'}`}
                          >
                            {favouritedPostCount}
                          </span>
                        </>
                      ) : t === 'Ads' ? (
                        '广告位'
                      ) : (
                        '组件'
                      )}
                    </button>
                  ))}
                </div>

                {/* 2. 🎨 主题切换器 */}
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <button
                    disabled={isThemeLoading}
                    onClick={() => setThemeMenuOpen(o => { const next = !o; if (next) void loadThemeSwitchQuota(); return next; })}
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 14px', borderRadius: '10px', border: `1px solid ${currentTheme.color}`, background: 'rgba(0,0,0,0.3)', color: '#eee', cursor: isThemeLoading ? 'wait' : 'pointer', fontSize: '12px', fontWeight: 'bold' }}
                  >
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: currentTheme.color, boxShadow: `0 0 8px ${currentTheme.color}`, flexShrink: 0 }} />
                    {isThemeLoading
                      ? <><span style={lightSpinStyle}></span>切换中...</>
                      : <>主题：{currentTheme.label}</>}
                    <span style={{ fontSize: '10px', color: '#999', transform: themeMenuOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▾</span>
                  </button>
                  {themeMenuOpen && (
                    <>
                      <div onClick={() => setThemeMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                      <div style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, minWidth: '240px', background: '#2a2a2e', border: '1px solid #555', borderRadius: '12px', padding: '8px', zIndex: 50, boxShadow: '0 12px 32px rgba(0,0,0,0.55)' }}>
                        <div style={{ fontSize: '10px', color: themeSwitchQuota.blocked ? '#f97316' : '#777', padding: '6px 10px 8px', letterSpacing: '0.5px' }}>
                          {formatThemeSwitchQuotaHint(themeSwitchQuota) || '选择主题'}
                        </div>
                        {ADMIN_THEMES.map(t => {
                          const active = currentActiveTheme === t.id;
                          const switchBlocked = !active && themeSwitchQuota.blocked;
                          const blockedHint = switchBlocked
                            ? formatThemeSwitchQuotaRemaining(themeSwitchQuota.remainingMs)
                            : '';
                          return (
                            <div key={t.id}
                              onClick={() => {
                                if (active || switchBlocked) {
                                  if (switchBlocked) {
                                    alert(blockedHint || '24 小时内主题切换已达上限');
                                  }
                                  return;
                                }
                                setThemeMenuOpen(false);
                                handleThemeChange(t.id);
                              }}
                              style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '8px', cursor: active ? 'default' : (switchBlocked ? 'not-allowed' : 'pointer'), background: active ? 'rgba(255,255,255,0.06)' : 'transparent', border: `1px solid ${active ? t.color : 'transparent'}`, marginBottom: '4px', opacity: switchBlocked ? 0.45 : 1 }}
                              onMouseEnter={e => { if (!active && !switchBlocked) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                              onMouseLeave={e => { if (!active && !switchBlocked) e.currentTarget.style.background = 'transparent'; }}
                            >
                              <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: t.color, flexShrink: 0, boxShadow: active ? `0 0 8px ${t.color}` : 'none' }} />
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#fff' }}>{t.label}</div>
                                <div style={{ fontSize: '11px', color: switchBlocked ? '#f97316' : '#888', marginTop: '2px' }}>
                                  {switchBlocked ? blockedHint : t.desc}
                                </div>
                              </div>
                              {active && <span style={{ color: t.color, fontSize: '11px', fontWeight: 'bold', flexShrink: 0 }}>● 生效中</span>}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* 3. 右侧视图栏 + 发布日期筛选 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', position: 'relative', flexShrink: 0 }}>
                {activeTab === 'Post' ? (
                  <>
                    <button
                      type="button"
                      className={`admin-recycle-btn${view === 'recycle' ? ' is-active' : ''}`}
                      onClick={openRecycleBin}
                      disabled={loading}
                      title="回收站"
                      aria-label="回收站"
                    >
                      <Icons.Trash />
                      {recycleCount > 0 ? (
                        <span className="admin-recycle-badge">{recycleCount}</span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className={`admin-list-select-btn${listSelectMode ? ' is-active' : ''}${listSelectMode && selectedPostIds.length > 0 ? ' is-delete' : ''}`}
                      onClick={handleListSelectButtonClick}
                      disabled={loading}
                    >
                      {listSelectMode
                        ? selectedPostIds.length > 0
                          ? `移入回收站（${selectedPostIds.length}）`
                          : '取消选择'
                        : '选择'}
                    </button>
                    {listSelectMode && selectedPostIds.length > 0 ? (
                      <button
                        type="button"
                        className="admin-list-select-btn"
                        onClick={handleClearSelection}
                        disabled={loading}
                      >
                        取消选择
                      </button>
                    ) : null}
                  </>
                ) : null}
                <SlidingNav activeIdx={navIdx} onSelect={handleNavClick} />
                {activeTab === 'Post' && (
                  <>
                    <button
                      type="button"
                      title={selectedPublishDate ? `筛选：${selectedPublishDate}` : '按发布日期筛选'}
                      onClick={() => {
                        setDatePickerOpen((o) => {
                          if (!o && selectedPublishDate) {
                            const parts = selectedPublishDate.split('-').map(Number);
                            if (parts.length === 3) setCalendarMonth(new Date(parts[0], parts[1] - 1, 1));
                          } else if (!o) {
                            setCalendarMonth(new Date());
                          }
                          return !o;
                        });
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '42px',
                        height: '42px',
                        borderRadius: '50%',
                        border: selectedPublishDate ? '1px solid greenyellow' : '1px solid #444',
                        background: selectedPublishDate ? 'rgba(173,255,47,0.12)' : '#202024',
                        color: selectedPublishDate ? 'greenyellow' : '#aaa',
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      <Icons.Calendar />
                    </button>
                    {datePickerOpen && (
                      <>
                        <div
                          onClick={() => setDatePickerOpen(false)}
                          style={{ position: 'fixed', inset: 0, zIndex: 50 }}
                        />
                        <AdminPublishCalendar
                          month={calendarMonth}
                          publishedDates={publishDatesSet}
                          selectedDate={selectedPublishDate}
                          onMonthChange={setCalendarMonth}
                          onSelectDate={handlePublishDateSelect}
                        />
                      </>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* 4. 列表渲染区域 */}
            <div style={viewMode === 'gallery' || viewMode === 'folder' ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '15px' } : {}}>
              {activeTab === 'Post' && viewMode !== 'folder' && syncingNewPostTitles.length > 0 && (
                <div className="post-sync-banner" role="status" aria-live="polite">
                  <span className="pubq-spin" />
                  <div>
                    <div className="post-sync-banner-title">正在更新刚发布的文章…</div>
                  </div>
                </div>
              )}
              {activeTab === 'Widget' && viewMode !== 'folder' && (
                <div onClick={openFriends} className="card-item" style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '18px 24px', background: 'linear-gradient(90deg,#3a3a3f,#2c2c30)', borderRadius: '12px', marginBottom: '12px', border: '1px solid greenyellow', cursor: 'pointer' }}>
                  <div style={{ fontSize: '28px' }}>🔗</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', fontSize: '17px', color: '#fff' }}>友链管理</div>
                    <div style={{ fontSize: '12px', color: '#aaa', marginTop: '2px' }}>添加 / 编辑 / 删除友情链接</div>
                  </div>
                  <div style={{ color: 'greenyellow', fontSize: '13px', fontWeight: 'bold' }}>进入 →</div>
                </div>
              )}
              {activeTab === 'Widget' && viewMode !== 'folder' && (
                <div onClick={openSocialLinks} className="card-item" style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '18px 24px', background: 'linear-gradient(90deg,#3a3a3f,#2c2c30)', borderRadius: '12px', marginBottom: '12px', border: '1px solid #38bdf8', cursor: 'pointer' }}>
                  <div style={{ fontSize: '28px' }}>🌐</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', fontSize: '17px', color: '#fff' }}>社媒组件</div>
                    <div style={{ fontSize: '12px', color: '#aaa', marginTop: '2px' }}>可添加微博、推特、Pixiv、Telegram、Instagram等社媒主页链接</div>
                  </div>
                  <div style={{ color: '#38bdf8', fontSize: '13px', fontWeight: 'bold' }}>进入 →</div>
                </div>
              )}
              {activeTab === 'Widget' && viewMode !== 'folder' && (
                <div onClick={openShopBanner} className="card-item" style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '18px 24px', background: 'linear-gradient(90deg,#3a3a3f,#2c2c30)', borderRadius: '12px', marginBottom: '12px', border: '1px solid #f472b6', cursor: 'pointer' }}>
                  <div style={{ fontSize: '28px' }}>🖼️</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', fontSize: '17px', color: '#fff' }}>Banner</div>
                    <div style={{ fontSize: '12px', color: '#aaa', marginTop: '2px' }}>首页顶部横幅多图轮播（仅shop主题生效）</div>
                  </div>
                  <div style={{ color: '#f472b6', fontSize: '13px', fontWeight: 'bold' }}>进入 →</div>
                </div>
              )}
              {activeTab === 'Widget' && viewMode !== 'folder' && (
                <div onClick={openVending} className="card-item" style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '18px 24px', background: 'linear-gradient(90deg,#3a3a3f,#2c2c30)', borderRadius: '12px', marginBottom: '12px', border: '1px solid #f97316', cursor: 'pointer' }}>
                  <div style={{ fontSize: '28px' }}>🛒</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', fontSize: '17px', color: '#fff' }}>贩售机</div>
                    <div style={{ fontSize: '12px', color: '#aaa', marginTop: '2px' }}>可对接外部发卡网站</div>
                  </div>
                  <div style={{ color: vendingLocked ? '#fbbf24' : '#f97316', fontSize: '13px', fontWeight: 'bold' }}>{vendingLocked ? '专业版' : '进入 →'}</div>
                </div>
              )}
              {activeTab === 'Widget' && viewMode !== 'folder' && (
                <div onClick={openBrandClean} className="card-item" style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '18px 24px', background: 'linear-gradient(90deg,#3a3a3f,#2c2c30)', borderRadius: '12px', marginBottom: '12px', border: '1px solid #34d399', cursor: 'pointer' }}>
                  <div style={{ fontSize: '28px' }}>🛡️</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', fontSize: '17px', color: '#fff' }}>去除平台角标</div>
                    <div style={{ fontSize: '12px', color: '#aaa', marginTop: '2px' }}>隐藏「在PRO+上创作」与页脚平台标识</div>
                  </div>
                  <div style={{ color: adsLocked ? '#fbbf24' : '#34d399', fontSize: '13px', fontWeight: 'bold' }}>{adsLocked ? '专业版' : '进入 →'}</div>
                </div>
              )}
              {activeTab === 'Widget' && viewMode !== 'folder' && (
                <div onClick={openContentProtect} className="card-item" style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '18px 24px', background: 'linear-gradient(90deg,#3a3a3f,#2c2c30)', borderRadius: '12px', marginBottom: '12px', border: '1px solid #60a5fa', cursor: 'pointer' }}>
                  <div style={{ fontSize: '28px' }}>🔒</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', fontSize: '17px', color: '#fff' }}>内容保护</div>
                    <div style={{ fontSize: '12px', color: '#aaa', marginTop: '2px' }}>限制读者右键复制 / 保存本站图片和内容</div>
                  </div>
                  <div style={{ color: '#60a5fa', fontSize: '13px', fontWeight: 'bold' }}>进入 →</div>
                </div>
              )}
              {activeTab === 'Widget' && viewMode !== 'folder' && (
                <div onClick={openStats} className="card-item" style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '18px 24px', background: 'linear-gradient(90deg,#3a3a3f,#2c2c30)', borderRadius: '12px', marginBottom: '12px', border: '1px solid #c084fc', cursor: 'pointer' }}>
                  <div style={{ width: '34px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><FiBarChart2 size={24} color="#c084fc" /></div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', fontSize: '17px', color: '#fff' }}>数据统计</div>
                    <div style={{ fontSize: '12px', color: '#aaa', marginTop: '2px' }}>今日实时与近 30 天浏览、访客来源</div>
                  </div>
                  <div style={{ color: '#c084fc', fontSize: '13px', fontWeight: 'bold' }}>进入 →</div>
                </div>
              )}
              {activeTab === 'Ads' && viewMode !== 'folder' && (
                <div onClick={openGalleryAd} className="card-item" style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '18px 24px', background: 'linear-gradient(90deg,#3a3a3f,#2c2c30)', borderRadius: '12px', marginBottom: '12px', border: '1px solid #f59e0b', cursor: 'pointer' }}>
                  <div style={{ fontSize: '28px' }}>📢</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', fontSize: '17px', color: '#fff' }}>内页广告位</div>
                    <div style={{ fontSize: '12px', color: '#aaa', marginTop: '2px' }}>内页底部广告横幅</div>
                  </div>
                  <div style={{ color: adsLocked ? '#fbbf24' : '#f59e0b', fontSize: '13px', fontWeight: 'bold' }}>{adsLocked ? '专业版' : '进入 →'}</div>
                </div>
              )}
              {activeTab === 'Ads' && viewMode !== 'folder' && (
                <div onClick={openPopupAd} className="card-item" style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '18px 24px', background: 'linear-gradient(90deg,#3a3a3f,#2c2c30)', borderRadius: '12px', marginBottom: '12px', border: '1px solid #a78bfa', cursor: 'pointer' }}>
                  <div style={{ fontSize: '28px' }}>🪟</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', fontSize: '17px', color: '#fff' }}>弹窗广告</div>
                    <div style={{ fontSize: '12px', color: '#aaa', marginTop: '2px' }}>进入首页弹出</div>
                  </div>
                  <div style={{ color: adsLocked ? '#fbbf24' : '#a78bfa', fontSize: '13px', fontWeight: 'bold' }}>{adsLocked ? '专业版' : '进入 →'}</div>
                </div>
              )}
              {activeTab === 'Ads' && viewMode !== 'folder' && (
                <div onClick={openClickAd} className="card-item" style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '18px 24px', background: 'linear-gradient(90deg,#3a3a3f,#2c2c30)', borderRadius: '12px', marginBottom: '12px', border: '1px solid #fb7185', cursor: 'pointer' }}>
                  <div style={{ fontSize: '28px' }}>🖱️</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', fontSize: '17px', color: '#fff' }}>遮罩广告</div>
                    <div style={{ fontSize: '12px', color: '#aaa', marginTop: '2px' }}>首次点击跳转</div>
                  </div>
                  <div style={{ color: adsLocked ? '#fbbf24' : '#fb7185', fontSize: '13px', fontWeight: 'bold' }}>{adsLocked ? '专业版' : '进入 →'}</div>
                </div>
              )}
              {activeTab === 'Widget' && viewMode !== 'folder' && (
                <div onClick={openAnnouncementPopup} className="card-item" style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '18px 24px', background: 'linear-gradient(90deg,#3a3a3f,#2c2c30)', borderRadius: '12px', marginBottom: '12px', border: '1px solid #38bdf8', cursor: 'pointer' }}>
                  <div style={{ fontSize: '28px' }}>📣</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', fontSize: '17px', color: '#fff' }}>公告弹窗</div>
                    <div style={{ fontSize: '12px', color: '#aaa', marginTop: '2px' }}>首页通知弹窗</div>
                  </div>
                  <div style={{ color: '#38bdf8', fontSize: '13px', fontWeight: 'bold' }}>进入 →</div>
                </div>
              )}
              {activeTab === 'Widget' && viewMode !== 'folder' && siteInfoWidget && (
                <div onClick={() => handleEdit(siteInfoWidget)} className="card-item" style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '18px 24px', background: 'linear-gradient(90deg,#3a3a3f,#2c2c30)', borderRadius: '12px', marginBottom: '12px', border: '1px solid greenyellow', cursor: 'pointer' }}>
                  <div style={{ fontSize: '28px' }}>🧩</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', fontSize: '17px', color: '#fff' }}>网站信息编辑</div>
                    <div style={{ fontSize: '12px', color: '#aaa', marginTop: '2px' }}>站点头像、标题与简介</div>
                  </div>
                  <div style={{ color: 'greenyellow', fontSize: '13px', fontWeight: 'bold' }}>进入 →</div>
                </div>
              )}
              {viewMode === 'folder' && (activeTab === 'Post' || activeTab === 'Favourites') && categoryFolderList.map(cat => (
                <div
                  key={cat}
                  onClick={() => {
                    setSelectedFolder(cat);
                    setNavIdx(1);
                    setViewMode('covered');
                  }}
                  style={{
                    padding: '15px',
                    paddingRight: '40px',
                    background: cat === FALLBACK_CATEGORY ? '#3a3a42' : '#424242',
                    borderRadius: '10px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    border: cat === selectedFolder ? '1px solid greenyellow' : (cat === FALLBACK_CATEGORY ? '1px solid #666' : '1px solid #555'),
                    cursor: 'pointer',
                    position: 'relative',
                  }}
                  className="btn-ia category-folder-card"
                >
                  <Icons.FolderIcon />{cat}
                  {!isSystemReservedCategory(cat) ? (
                    <button
                      type="button"
                      className="category-folder-del"
                      onClick={(e) => { e.stopPropagation(); requestDeleteCategory(cat); }}
                      title={`永久删除分类「${cat}」（相关文章将归入「${FALLBACK_CATEGORY}」）`}
                      aria-label={`永久删除分类 ${cat}`}
                    >
                      <Icons.Trash />
                    </button>
                  ) : null}
                </div>
              ))}
              {viewMode !== 'folder' && filtered.map((p, index) => {
                const st = (p.status === 'Draft') ? { borderColor: '#f97316', color: '#f97316', label: '📝 草稿' } : { borderColor: 'transparent', color: 'greenyellow', label: '🚀 已发布' };
                // 自定义页面：用横幅样式(与「友链管理」一致)，不依赖封面图，避免 cover 为图标路径(如 me.svg)时的破图
                if (activeTab === 'Page') {
                  return (
                    <div key={p.id} onClick={() => handlePreview(p)} className="card-item" style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '18px 24px', background: 'linear-gradient(90deg,#3a3a3f,#2c2c30)', borderRadius: '12px', marginBottom: '12px', border: `1px solid ${st.borderColor}`, cursor: 'pointer' }}>
                      <div style={{ fontSize: '28px' }}>📄</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 'bold', fontSize: '17px', color: '#fff' }}>{p.title}</div>
                        <div style={{ fontSize: '12px', color: '#aaa', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <span style={{ border: `1px solid ${st.color}`, color: st.color, padding: '2px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: 'bold' }}>{st.label}</span>
                          {p.date ? <span>{p.date}</span> : null}
                        </div>
                      </div>
                      {renderCardDrawer(p)}
                    </div>
                  );
                }
                const pinBadge = p.pinned ? <span className="pin-badge">📌 置顶</span> : null;
                return (
                  <React.Fragment key={p.id}>
                    {activeTab === 'Post' && pinnedDividerIndex > 0 && index === pinnedDividerIndex ? (
                      <div className="pin-divider" style={viewMode === 'gallery' ? { gridColumn: '1 / -1' } : {}}>
                        <span>置顶分割线</span>
                      </div>
                    ) : null}
                  <div
                    onClick={() => handlePostCardClick(p)}
                    className={`card-item${listSelectMode && activeTab === 'Post' && selectedPostIds.includes(p.id) ? ' is-selected' : ''}`}
                    style={{
                      ...(viewMode === 'text' ? { display: 'flex', alignItems: 'center', padding: '16px 20px' } : viewMode === 'gallery' ? { display: 'flex', flexDirection: 'column', height: 'auto' } : {}),
                      background: p.pinned ? '#4a4638' : '#424242',
                      borderRadius: '12px',
                      marginBottom: '8px',
                      border: p.pinned ? '1px solid rgba(251, 191, 36, 0.45)' : `1px solid ${st.borderColor}`,
                      position: listSelectMode && activeTab === 'Post' ? 'relative' : undefined,
                    }}
                  >
                    {renderPostSelectMark(p.id)}
                    {viewMode === 'covered' && <><div style={{ width: '160px', flexShrink: 0, background: '#303030', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{p.cover ? <img src={p.cover} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <div style={{ fontSize: '28px', color: '#444' }}>{activeTab[0]}</div>}</div><div style={{ padding: '20px 35px', flex: 1 }}><div style={{ fontWeight: 'bold', fontSize: '20px', color: '#fff', marginBottom: '8px' }}>{pinBadge}{p.title}</div><div style={{ color: 'rgba(255,255,255,0.8)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '10px' }}><span style={{ border: `1px solid ${st.color}`, color: st.color, padding: '2px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: 'bold' }}>{st.label}</span>{renderCardCategoryChip(p)} · {p.date}</div></div></>}
                    {viewMode === 'text' && <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}><div style={{ flex: 1, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '10px' }}><span style={{ width: '6px', height: '6px', borderRadius: '50%', background: p.pinned ? '#fbbf24' : st.color }}></span>{pinBadge}{p.title}</div><div style={{ color: 'rgba(255,255,255,0.8)', fontSize: '12px' }}>{renderCardCategoryChip(p)} · {p.date}</div></div>}
                    {viewMode === 'gallery' && <><div style={{ height: '140px', background: '#303030', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}><div style={{ position: 'absolute', top: '10px', left: '10px', background: p.pinned ? '#fbbf24' : 'transparent', color: '#000', padding: p.pinned ? '2px 6px' : 0, borderRadius: '4px', fontSize: '10px', fontWeight: 'bold' }}>{p.pinned ? 'PIN' : ''}</div><div style={{ position: 'absolute', top: '10px', right: '10px', background: st.color, color: '#000', padding: '2px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: 'bold' }}>{p.status === 'Draft' ? 'DRAFT' : 'PUB'}</div>{p.cover ? <img src={p.cover} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <div style={{ fontSize: '40px', color: '#444' }}>{activeTab[0]}</div>}</div><div style={{ padding: '15px' }}><div style={{ fontSize: '14px', fontWeight: 'bold', color: '#fff' }}>{p.title}</div><div style={{ color: 'rgba(255,255,255,0.8)', fontSize: '12px' }}>{renderCardCategoryChip(p)} · {p.date}</div></div></>}
                    {renderCardDrawer(p, { showPin: activeTab === 'Post' || activeTab === 'Favourites' })}
                  </div>
                  </React.Fragment>
                 );
               })}
             </div>
             {cardCatOpenId && (
               <CardCategoryQuickPicker
                 anchorRect={cardCatMenuRect}
                 currentCategory={(posts.find((p) => p.id === cardCatOpenId) || {}).category || ''}
                 categories={options.categories || []}
                 onPick={(value) => handleCardCategoryPick(cardCatOpenId, value)}
                 onClose={() => { setCardCatOpenId(null); setCardCatMenuRect(null); }}
               />
             )}
           </main>
         ) : view === 'recycle' ? (
          <main>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <div>
                <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#fff' }}>回收站</div>
                <div style={{ fontSize: '12px', color: '#888', marginTop: '4px' }}>
                  共 {recyclePosts.length} 篇 · 移入回收站的文章不会在前台显示
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {listSelectMode && recyclePosts.length > 0 ? (
                  <button
                    type="button"
                    className={`admin-list-select-btn${recycleAllSelected ? ' is-active' : ''}`}
                    onClick={toggleRecycleSelectAll}
                    disabled={loading}
                  >
                    {recycleAllSelected ? '取消全选' : '全选'}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`admin-list-select-btn${listSelectMode ? ' is-active' : ''}${listSelectMode && selectedPostIds.length > 0 ? ' is-delete' : ''}`}
                  onClick={handleListSelectButtonClick}
                  disabled={loading || recyclePosts.length === 0}
                >
                  {listSelectMode
                    ? selectedPostIds.length > 0
                      ? `彻底删除（${selectedPostIds.length}）`
                      : '取消选择'
                    : '选择'}
                </button>
                {listSelectMode && selectedPostIds.length > 0 ? (
                  <button
                    type="button"
                    className="admin-list-select-btn"
                    onClick={handleClearSelection}
                    disabled={loading}
                  >
                    取消选择
                  </button>
                ) : null}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {recyclePosts.length === 0 ? (
                <div style={{ textAlign: 'center', color: '#888', padding: '48px 20px' }}>
                  回收站为空
                </div>
              ) : (
                recyclePosts.map((p) => (
                  <div
                    key={p.id}
                    onClick={() => handlePostCardClick(p)}
                    className={`card-item${listSelectMode && selectedPostIds.includes(p.id) ? ' is-selected' : ''}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      padding: '16px 20px',
                      background: '#424242',
                      borderRadius: '12px',
                      marginBottom: '8px',
                      border: '1px solid #555',
                      position: listSelectMode ? 'relative' : undefined,
                    }}
                  >
                    {renderPostSelectMark(p.id)}
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                      <div style={{ flex: 1, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#f87171' }} />
                        {p.title}
                      </div>
                      <div style={{ color: '#aaa', fontSize: '12px' }}>
                        {p.category ? `${p.category} · ` : ''}{p.date || '—'}
                      </div>
                    </div>
                    {!listSelectMode ? renderRecycleCardDrawer(p) : null}
                  </div>
                ))
              )}
            </div>
          </main>
        ) : view === 'crawler-ingest' ? (
          <CrawlerIngestPanel
            configured={crawlerIngestConfigured}
            summary={crawlerIngestSummary}
            tab={crawlerIngestTab}
            onTabChange={(tab) => {
              setCrawlerIngestTab(tab);
              setCrawlerIngestSelectedIds([]);
              fetchCrawlerIngestTab(tab);
            }}
            pendingItems={crawlerIngestPendingList}
            processingItems={crawlerIngestProcessingList}
            failedItems={crawlerIngestFailedList}
            logItems={crawlerIngestList}
            selectedIds={crawlerIngestSelectedIds}
            onToggleRow={toggleCrawlerIngestRow}
            onSelectAllPending={selectAllCrawlerPending}
            onSelectAllFailed={selectAllCrawlerFailed}
            onSelectAllProcessing={selectAllCrawlerProcessing}
            onClearSelection={clearCrawlerIngestSelection}
            busy={crawlerIngestBusy}
            progress={crawlerIngestProgress}
            autoSettings={crawlerIngestAutoSettings}
            onSaveAutoSettings={handleSaveCrawlerAutoSettings}
            onIngestSelected={handleCrawlerIngestSelected}
            onIngestAll={handleCrawlerIngestAll}
            onDeleteSelected={handleCrawlerQueueDeleteSelected}
            onRetrySelected={handleCrawlerRetrySelected}
            onReclaimStale={handleCrawlerReclaimStale}
            onResetProcessingSelected={handleCrawlerResetProcessingSelected}
            onCancel={cancelCrawlerIngest}
            onRetry={handleCrawlerIngestRetry}
            onRefresh={refreshCrawlerIngestPanel}
            onBack={leaveCrawlerIngestView}
          />
        ) : view === 'social-links' ? (
          <div style={{background: '#424242', padding: 30, borderRadius: 20}}>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'22px'}}>
              <div style={{fontSize:'20px', fontWeight:'bold', color:'#fff'}}>🌐 社媒功能</div>
              <div style={{fontSize:'12px', color:'#888'}}>全主题社交媒体入口</div>
            </div>

            {socialLinksLoading ? (
              <div style={{color:'#888', textAlign:'center', padding:'30px'}}>加载中...</div>
            ) : (
              <>
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'20px', padding:'22px 24px', background:'#333', borderRadius:'14px', border:'1px solid #555', marginBottom:'18px'}}>
                  <div>
                    <div style={{fontSize:'16px', fontWeight:'bold', color:'#fff', marginBottom:'6px'}}>社媒功能</div>
                    <div style={{fontSize:'12px', color:'#999'}}>{socialLinks.enabled ? '当前：已开启' : '当前：已关闭'}</div>
                  </div>
                  <button
                    type="button"
                    disabled={socialLinksSaving}
                    onClick={() => saveSocialLinks({ enabled: !socialLinks.enabled })}
                    style={{
                      minWidth: '88px',
                      padding: '12px 20px',
                      border: 'none',
                      borderRadius: '999px',
                      fontWeight: 'bold',
                      fontSize: '14px',
                      cursor: socialLinksSaving ? 'wait' : 'pointer',
                      background: socialLinks.enabled ? '#22c55e' : '#555',
                      color: '#fff',
                      opacity: socialLinksSaving ? 0.6 : 1,
                    }}
                  >
                    {socialLinksSaving ? '保存中…' : (socialLinks.enabled ? '已开启' : '已关闭')}
                  </button>
                </div>

                <div style={{display:'flex', flexDirection:'column', gap:'12px'}}>
                  {normalizeSocialLinks(socialLinks.links).map((item) => {
                    const meta = SOCIAL_LINK_PLATFORMS.find((p) => p.platform === item.platform);
                    return (
                      <div key={item.platform} style={{display:'grid', gridTemplateColumns:'140px minmax(240px, 1fr) 130px', gap:'12px', alignItems:'center', background:'#333', padding:'14px', borderRadius:'12px', border:'1px solid #555'}}>
                        <div>
                          <div style={{fontSize:'14px', fontWeight:'bold', color:'#fff'}}>{meta?.label || item.name}</div>
                          <div style={{fontSize:'11px', color:'#888', marginTop:'4px'}}>{item.platform}</div>
                        </div>
                        <input
                          className="glow-input"
                          value={item.url}
                          onChange={(e) => updateSocialLink(item.platform, {
                            url: e.target.value,
                            status: e.target.value.trim() && item.status === 'Hidden' ? 'Published' : item.status,
                          })}
                          placeholder={meta?.placeholder || 'https://...'}
                          style={{fontSize:'13px'}}
                        />
                        <select
                          className="glow-input"
                          value={item.status || 'Hidden'}
                          onChange={(e) => updateSocialLink(item.platform, { status: e.target.value })}
                          style={{fontSize:'13px'}}
                        >
                          <option value="Published">显示</option>
                          <option value="Hidden">隐藏</option>
                        </select>
                      </div>
                    );
                  })}
                </div>

                <div style={{fontSize:'12px', color:'#aaa', lineHeight:1.8, marginTop:'18px'}}>
                  如需激活，请填写社交链接并设为“显示”。
                </div>

                <button
                  type="button"
                  onClick={() => saveSocialLinks()}
                  disabled={socialLinksSaving}
                  style={{width:'100%', padding:'18px', background: socialLinksSaving ? '#333' : '#fff', color: socialLinksSaving ? '#666' : '#000', border:'none', borderRadius:'12px', fontWeight:'bold', fontSize:'15px', cursor: socialLinksSaving ? 'wait' : 'pointer', marginTop:'28px'}}
                >
                  {socialLinksSaving ? '保存中…' : '保存社媒组件'}
                </button>
              </>
            )}
          </div>
        ) : view === 'vending' ? (
          <div style={{background: '#424242', padding: 30, borderRadius: 20}}>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'22px'}}>
              <div style={{fontSize:'20px', fontWeight:'bold', color:'#fff'}}>🛒 贩售机</div>
              <div style={{fontSize:'12px', color:'#888'}}>可对接外部发卡网站</div>
            </div>

            {vendingLoading ? (
              <div style={{color:'#888', textAlign:'center', padding:'30px'}}>加载中...</div>
            ) : (
              <>
                {vendingLocked && (
                  <div style={ADS_LOCKED_NOTICE_STYLE}>贩售机组件为专业版权益，升级后可用</div>
                )}
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'20px', padding:'22px 24px', background:'#333', borderRadius:'14px', border:'1px solid #555', marginBottom:'18px', opacity: vendingLocked ? 0.55 : 1}}>
                  <div>
                    <div style={{fontSize:'16px', fontWeight:'bold', color:'#fff', marginBottom:'6px'}}>贩售机功能</div>
                    <div style={{fontSize:'12px', color:'#999'}}>{vendingEnabled ? '当前：已开启' : vendingEditing ? '当前：已关闭 · 修改未保存' : '当前：已关闭'}{vendingLocked ? '（免费版由平台统一维护）' : ''}</div>
                  </div>
                  <button
                    type="button"
                    disabled={vendingSaving}
                    onClick={() => {
                      if (vendingLocked) { alert('贩售机组件为专业版权益，升级后可用'); return; }
                      if (vendingEnabled) { saveVending({ enabled: false }); return; }
                      if (vendingEditing) { discardVendingEditing(); return; }
                      startVendingEditing();
                    }}
                    title={vendingEditing ? '放弃修改并收起' : undefined}
                    style={{
                      minWidth: '88px',
                      padding: '12px 20px',
                      border: 'none',
                      borderRadius: '999px',
                      fontWeight: 'bold',
                      fontSize: '14px',
                      cursor: vendingSaving ? 'wait' : 'pointer',
                      background: vendingLocked ? '#444' : vendingEnabled ? '#22c55e' : vendingEditing ? '#d97706' : '#555',
                      color: '#fff',
                      opacity: vendingSaving ? 0.6 : vendingLocked ? 0.7 : 1,
                    }}
                  >
                    {vendingSaving ? '保存中…' : vendingLocked ? '专业版' : (vendingEnabled ? '已开启' : vendingEditing ? '未保存' : '已关闭')}
                  </button>
                </div>
                {SHOW_VENDING_ADDRESS_ADMIN && (vendingEnabled || vendingEditing) && (
                <div style={{display:'flex', flexDirection:'column', gap:'16px', padding:'22px 24px', background:'#333', borderRadius:'14px', border:'1px solid #555', opacity: vendingLocked ? 0.55 : 1}}>
                  <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'14px'}}>
                    <div>
                      <div style={{fontSize:'15px', fontWeight:'bold', color:'#fff', marginBottom:'4px'}}>地址管理</div>
                      <div style={{fontSize:'12px', color:'#999'}}>
                        {vendingAddressUnlocked ? '已解锁：可编辑地址' : '已锁定'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (vendingLocked) { alert('贩售机组件为专业版权益，升级后可用'); return; }
                        // P18FREEPRO: 专业版免维护密码直接解锁贩售机地址编辑(用户2026-08-30)
                        if (sitePlan === 'pro') { setVendingAddressUnlockError(''); setVendingAddressUnlocked(true); showAdminToast('贩售机地址编辑已解锁(专业版)'); return; }
                        setVendingAddressUnlockError('');
                        setVendingAddressUnlockClosing(false);
                        setVendingAddressUnlockOpen(true);
                      }}
                      disabled={vendingSaving || vendingAddressUnlocked}
                      style={{
                        padding:'10px 16px',
                        background: vendingLocked ? '#444' : vendingAddressUnlocked ? '#2f5136' : '#9a6dd7',
                        color:'#fff',
                        border:'none',
                        borderRadius:'999px',
                        fontWeight:'bold',
                        cursor: vendingAddressUnlocked ? 'default' : 'pointer',
                        opacity: vendingSaving ? 0.6 : vendingLocked ? 0.7 : 1,
                      }}
                    >
                      {vendingAddressUnlocked ? '已解锁' : '解锁编辑'}
                    </button>
                  </div>
                  <div>
                    <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>按钮名称</label>
                    <input className="glow-input" value={vendingTitle} onChange={e=>setVendingTitle(e.target.value)} placeholder="贩售机" disabled={vendingLocked || !vendingAddressUnlocked || vendingSaving} />
                  </div>
                  <div>
                    <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>贩售机地址 <span style={{color:'#ff4d4f'}}>*</span></label>
                    <input className="glow-input" value={vendingUrl} onChange={e=>setVendingUrl(e.target.value)} placeholder="https://store.proplus.onl/buy" disabled={vendingLocked || !vendingAddressUnlocked || vendingSaving} />
                    <div style={{fontSize:'11px', color:'#888', marginTop:'8px', lineHeight:1.6}}>地址默认由平台维护。</div>
                  </div>
                  {vendingEditing ? (
                    <button
                      type="button"
                      onClick={() => vendingLocked ? alert('贩售机组件为专业版权益，升级后可用') : saveVending({ includeAddress: vendingAddressUnlocked, enabled: true })}
                      disabled={vendingSaving}
                      style={{padding:'16px', background: vendingSaving ? '#333' : '#fff', color: vendingSaving ? '#666' : '#000', border:'none', borderRadius:'12px', fontWeight:'bold', fontSize:'15px', cursor: vendingSaving ? 'wait' : 'pointer'}}
                    >
                      {vendingSaving ? '保存中…' : '保存并开启'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => vendingLocked ? alert('贩售机组件为专业版权益，升级后可用') : saveVending({ includeAddress: true })}
                      disabled={vendingSaving || !vendingAddressUnlocked}
                      style={{padding:'16px', background: (vendingSaving || !vendingAddressUnlocked) ? '#333' : '#fff', color: (vendingSaving || !vendingAddressUnlocked) ? '#666' : '#000', border:'none', borderRadius:'12px', fontWeight:'bold', fontSize:'15px', cursor: vendingSaving ? 'wait' : (vendingAddressUnlocked ? 'pointer' : 'not-allowed')}}
                    >
                      {vendingSaving ? '保存中…' : '保存地址设置'}
                    </button>
                  )}
                </div>
                )}
                {vendingEditing && !SHOW_VENDING_ADDRESS_ADMIN && (
                  <button
                    type="button"
                    onClick={() => vendingLocked ? alert('贩售机组件为专业版权益，升级后可用') : saveVending({ includeAddress: false, enabled: true })}
                    disabled={vendingSaving}
                    style={{padding:'16px', background: vendingSaving ? '#333' : '#fff', color: vendingSaving ? '#666' : '#000', border:'none', borderRadius:'12px', fontWeight:'bold', fontSize:'15px', cursor: vendingSaving ? 'wait' : 'pointer', marginTop:'18px'}}
                  >
                    {vendingSaving ? '保存中…' : '保存并开启'}
                  </button>
                )}
              </>
            )}
          </div>
        ) : view === 'brand-clean' ? (
          <div style={{background: '#424242', padding: 30, borderRadius: 20}}>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'22px'}}>
              <div style={{fontSize:'20px', fontWeight:'bold', color:'#fff'}}>去除平台角标</div>
              <div style={{fontSize:'12px', color:'#888'}}>隐藏「在PRO+上创作」与页脚平台标识</div>
            </div>

            {brandCleanLoading ? (
              <div style={{color:'#888', textAlign:'center', padding:'30px'}}>加载中...</div>
            ) : (
              <>
                {adsLocked && (
                  <div style={ADS_LOCKED_NOTICE_STYLE}>去除平台角标为专业版权益，升级后可用</div>
                )}
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'20px', padding:'22px 24px', background:'#333', borderRadius:'14px', border:'1px solid #555', opacity: adsLocked ? 0.55 : 1}}>
                  <div>
                    <div style={{fontSize:'16px', fontWeight:'bold', color:'#fff', marginBottom:'6px'}}>平台角标展示</div>
                    <div style={{fontSize:'12px', color:'#999', lineHeight:1.7}}>
                      开启后，前台「在PRO+上创作」按钮与页脚「Powered by PRO+」将隐藏，
                      页脚转为显示你的站名；关闭后恢复展示。
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={brandCleanSaving}
                    onClick={() => toggleBrandClean(!brandCleanEnabled)}
                    style={{
                      minWidth: '88px',
                      padding: '12px 20px',
                      border: 'none',
                      borderRadius: '999px',
                      fontWeight: 'bold',
                      fontSize: '14px',
                      cursor: brandCleanSaving ? 'wait' : 'pointer',
                      background: adsLocked ? '#444' : brandCleanEnabled ? '#22c55e' : '#555',
                      color: '#fff',
                      opacity: brandCleanSaving ? 0.6 : adsLocked ? 0.7 : 1,
                    }}
                  >
                    {brandCleanSaving ? '保存中…' : adsLocked ? '专业版' : (brandCleanEnabled ? '已去除' : '展示中')}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : view === 'content-protect' ? (
          <div style={{background: '#424242', padding: 30, borderRadius: 20}}>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'22px'}}>
              <div style={{fontSize:'20px', fontWeight:'bold', color:'#fff'}}>内容保护</div>
              <div style={{fontSize:'12px', color:'#888'}}>全主题 · 读者端生效</div>
            </div>

            {contentProtectLoading ? (
              <div style={{color:'#888', textAlign:'center', padding:'30px'}}>加载中...</div>
            ) : (
              <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'20px', padding:'22px 24px', background:'#333', borderRadius:'14px', border:'1px solid #555'}}>
                <div>
                  <div style={{fontSize:'16px', fontWeight:'bold', color:'#fff', marginBottom:'6px'}}>复制 / 保存防护</div>
                  <div style={{fontSize:'12px', color:'#999', lineHeight:1.7}}>
                    {contentProtectEnabled
                      ? '开启后，读者无法右键复制/保存本站图片（本页原创保护）'
                      : '开启后，读者端将禁用右键菜单、复制与图片拖存；图库点击查看大图不受影响，后台操作不受影响。'}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={contentProtectSaving}
                  onClick={() => toggleContentProtect(!contentProtectEnabled)}
                  style={{
                    minWidth: '88px',
                    padding: '12px 20px',
                    border: 'none',
                    borderRadius: '999px',
                    fontWeight: 'bold',
                    fontSize: '14px',
                    cursor: contentProtectSaving ? 'wait' : 'pointer',
                    background: contentProtectEnabled ? '#22c55e' : '#555',
                    color: '#fff',
                    opacity: contentProtectSaving ? 0.6 : 1,
                  }}
                >
                  {contentProtectSaving ? '保存中…' : (contentProtectEnabled ? '已开启' : '已关闭')}
                </button>
              </div>
            )}
          </div>
        ) : view === 'shop-banner' ? (
          <div style={{background: '#424242', padding: 30, borderRadius: 20}}>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'22px'}}>
              <div style={{fontSize:'20px', fontWeight:'bold', color:'#fff'}}>🖼️ Banner</div>
              <div style={{fontSize:'12px', color:'#888'}}>Shop 主题首页顶部 · 单图静态 / 多图轮播</div>
            </div>

            {shopBannerLoading ? (
              <div style={{color:'#888', textAlign:'center', padding:'30px'}}>加载中...</div>
            ) : (
              <div>
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'20px', padding:'22px 24px', background:'#333', borderRadius:'14px', border:'1px solid #555', marginBottom:'18px'}}>
                  <div>
                    <div style={{fontSize:'16px', fontWeight:'bold', color:'#fff', marginBottom:'6px'}}>Banner 开关</div>
                    <div style={{fontSize:'12px', color:'#999'}}>
                      {shopBanner.enabled ? '当前：已开启 · 仅在 shop 主题首页展示，其他主题不展示' : shopBannerEditing ? '当前：已关闭 · 修改未保存' : '当前：已关闭'}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={shopBannerSaving}
                    onClick={() => {
                      if (shopBanner.enabled) { saveShopBanner({ enabled: false }); return; }
                      if (shopBannerEditing) { discardShopBannerEditing(); return; }
                      startShopBannerEditing();
                    }}
                    title={shopBannerEditing ? '放弃修改并收起' : undefined}
                    style={{
                      minWidth: '88px',
                      padding: '12px 20px',
                      border: 'none',
                      borderRadius: '999px',
                      fontWeight: 'bold',
                      fontSize: '14px',
                      cursor: shopBannerSaving ? 'wait' : 'pointer',
                      background: shopBanner.enabled ? '#22c55e' : shopBannerEditing ? '#d97706' : '#555',
                      color: '#fff',
                      opacity: shopBannerSaving ? 0.6 : 1,
                    }}
                  >
                    {shopBannerSaving ? '保存中…' : (shopBanner.enabled ? '已开启' : shopBannerEditing ? '未保存' : '已关闭')}
                  </button>
                </div>
                {(shopBanner.enabled || shopBannerEditing) && (
                <>
                <div style={{display:'flex', flexDirection:'column', gap:'16px'}}>
                  <div>
                    <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>Banner 图片 <span style={{color:'#ff4d4f'}}>*</span> <span style={{color:'#777', fontWeight:'normal'}}>(拖入或点击上传，第 2 张起自动轮播，缩略图可拖拽排序)</span></label>
                    <label
                      className="img-drop"
                      style={{
                        position:'relative',
                        minHeight:'92px',
                        padding:'16px',
                        marginBottom:'12px',
                        borderColor: shopBannerDragOver ? 'greenyellow' : undefined,
                        background: shopBannerDragOver ? '#1f261b' : undefined,
                        color: shopBannerDragOver ? 'greenyellow' : undefined,
                        cursor: shopBannerSaving ? 'wait' : 'pointer',
                      }}
                      onDragEnter={e => {
                        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
                        e.preventDefault();
                        shopBannerDragDepthRef.current += 1;
                        setShopBannerDragOver(true);
                      }}
                      onDragLeave={e => {
                        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
                        e.preventDefault();
                        shopBannerDragDepthRef.current = Math.max(0, shopBannerDragDepthRef.current - 1);
                        if (shopBannerDragDepthRef.current === 0) setShopBannerDragOver(false);
                      }}
                      onDragOver={e => {
                        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'copy';
                        setShopBannerDragOver(true);
                      }}
                      onDrop={e => {
                        e.preventDefault();
                        resetShopBannerDragOver();
                        if (shopBannerSaving || shopBannerUpload) return;
                        handleShopBannerFiles(e.dataTransfer?.files);
                      }}
                    >
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        style={{display:'none'}}
                        disabled={shopBannerSaving}
                        onChange={e => { handleShopBannerFiles(e.target.files); e.target.value = ''; }}
                      />
                      <div style={{pointerEvents:'none', textAlign:'center'}}>
                        <div style={{fontSize:'13px', marginBottom:'4px', fontWeight: shopBannerDragOver || shopBannerUpload ? 'bold' : 'normal'}}>
                          {shopBannerUpload
                            ? `正在上传 ${shopBannerUpload.done}/${shopBannerUpload.total}…`
                            : shopBannerDragOver
                              ? '松开鼠标，添加到 Banner'
                              : '拖拽或点击上传图片（支持多张）'}
                        </div>
                        <div style={{fontSize:'12px', color:'#777'}}>建议宽幅横图（如 1600×500）· 最多 8 张</div>
                      </div>
                    </label>
                    {shopBannerUploadError ? (
                      <div style={{color:'#ff7875', fontSize:'12px', marginBottom:'10px'}}>{shopBannerUploadError}</div>
                    ) : null}
                    {(() => {
                      const bannerImages = getShopBannerImages();
                      const canEditBanner = !shopBannerSaving && !shopBannerUpload;
                      if (bannerImages.length === 0) {
                        return (
                          <div style={{fontSize:'12px', color:'#777', padding:'4px 2px'}}>还没有图片，先拖入或点击上方区域上传</div>
                        );
                      }
                      return (
                        <div style={{display:'flex', flexWrap:'wrap', gap:'10px'}}>
                          {bannerImages.map((url, index) => (
                            <div
                              key={url + '#' + index}
                              draggable={canEditBanner}
                              onDragStart={e => handleShopBannerThumbDragStart(index, e)}
                              onDragEnd={() => setShopBannerDragIndex(null)}
                              onDragOver={e => { if (shopBannerDragIndex != null) e.preventDefault(); }}
                              onDrop={e => { if (shopBannerDragIndex != null) handleShopBannerThumbDrop(index, e); }}
                              style={{
                                position:'relative',
                                width:'132px',
                                height:'74px',
                                borderRadius:'8px',
                                overflow:'hidden',
                                background:'#222',
                                border: shopBannerDragIndex === index ? '2px solid greenyellow' : '1px solid #555',
                                opacity: shopBannerDragIndex != null && shopBannerDragIndex !== index ? 0.7 : 1,
                                cursor: canEditBanner ? 'grab' : 'default',
                                transition:'opacity 0.15s ease, border-color 0.15s ease',
                              }}
                              title={'第 ' + (index + 1) + ' 张 · 拖拽排序'}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={url} alt="" draggable={false} style={{width:'100%', height:'100%', objectFit:'cover', display:'block'}} />
                              <span style={{position:'absolute', left:'6px', top:'6px', background:'rgba(0,0,0,0.55)', color:'#fff', fontSize:'11px', lineHeight:1.4, padding:'1px 7px', borderRadius:'999px'}}>{index + 1}</span>
                              <button
                                type="button"
                                disabled={!canEditBanner}
                                onClick={() => setShopBannerImages(getShopBannerImages().filter((_, i) => i !== index))}
                                style={{position:'absolute', right:'4px', top:'4px', width:'22px', height:'22px', borderRadius:'50%', border:'none', background:'rgba(0,0,0,0.55)', color:'#fff', fontSize:'14px', lineHeight:1, cursor: canEditBanner ? 'pointer' : 'not-allowed', opacity: canEditBanner ? 1 : 0.5}}
                                title="删除"
                              >×</button>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                  <div>
                    <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>跳转链接 <span style={{color:'#777', fontWeight:'normal'}}>(可选)</span></label>
                    <input className="glow-input" value={shopBanner.link} disabled={shopBannerSaving} onChange={e=>setShopBanner({...shopBanner, link: e.target.value})} placeholder="https://example.com 或 /archive" />
                  </div>
                  <div style={{fontSize:'12px', color:'#888', lineHeight:1.7, padding:'14px 16px', background:'#2f2f33', borderRadius:'10px'}}>
                    1 张图片为静态展示，2 张及以上自动轮播（约 5 秒一切换，底部圆点可切换，支持移动端滑动）。建议使用宽幅横图（如 1600×500）。
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => shopBannerEditing ? saveShopBanner({ enabled: true }) : saveShopBanner()}
                  disabled={shopBannerSaving}
                  style={{width:'100%', padding:'18px', background: shopBannerSaving ? '#333' : '#fff', color: shopBannerSaving ? '#666' : '#000', border:'none', borderRadius:'12px', fontWeight:'bold', fontSize:'15px', cursor: shopBannerSaving ? 'wait' : 'pointer', marginTop:'32px'}}
                >
                  {shopBannerSaving ? '保存中…' : '保存 Banner'}
                </button>
                </>
                )}
              </div>
            )}
          </div>
        ) : view === 'announcement-popup' ? (
          <div style={{background: '#424242', padding: 30, borderRadius: 20}}>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'22px'}}>
              <div style={{fontSize:'20px', fontWeight:'bold', color:'#fff'}}>📣 公告弹窗</div>
              <div style={{fontSize:'12px', color:'#888'}}>全站通知弹窗（无跳转按钮）</div>
            </div>

            {announcementPopupLoading ? (
              <div style={{color:'#888', textAlign:'center', padding:'30px'}}>加载中...</div>
            ) : (
              <>
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'20px', padding:'22px 24px', background:'#333', borderRadius:'14px', border:'1px solid #555', marginBottom:'18px'}}>
                  <div>
                    <div style={{fontSize:'16px', fontWeight:'bold', color:'#fff', marginBottom:'6px'}}>弹窗功能</div>
                    <div style={{fontSize:'12px', color:'#999'}}>{announcementPopup.enabled ? '当前：已开启 · 仅作站务通知，不含广告跳转按钮' : announcementPopupEditing ? '当前：已关闭 · 修改未保存' : '当前：已关闭'}</div>
                  </div>
                  <button
                    type="button"
                    disabled={announcementPopupSaving}
                    onClick={() => {
                      if (announcementPopup.enabled) { saveAnnouncementPopup({ enabled: false }); return; }
                      if (announcementPopupEditing) { discardAnnouncementPopupEditing(); return; }
                      startAnnouncementPopupEditing();
                    }}
                    title={announcementPopupEditing ? '放弃修改并收起' : undefined}
                    style={{
                      minWidth: '88px',
                      padding: '12px 20px',
                      border: 'none',
                      borderRadius: '999px',
                      fontWeight: 'bold',
                      fontSize: '14px',
                      cursor: announcementPopupSaving ? 'wait' : 'pointer',
                      background: announcementPopup.enabled ? '#22c55e' : announcementPopupEditing ? '#d97706' : '#555',
                      color: '#fff',
                      opacity: announcementPopupSaving ? 0.6 : 1,
                    }}
                  >
                    {announcementPopupSaving ? '保存中…' : (announcementPopup.enabled ? '已开启' : announcementPopupEditing ? '未保存' : '已关闭')}
                  </button>
                </div>
                {(announcementPopup.enabled || announcementPopupEditing) && (
                <>
                <div style={{display:'flex', gap:'24px', alignItems:'flex-start', flexWrap:'wrap'}}>
                  <div>
                    <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'8px'}}>附图 <span style={{color:'#777', fontWeight:'normal'}}>(选填)</span></label>
                    <label className="img-drop" style={{width:'280px', height:'150px', minHeight:'150px', padding:0, borderRadius:'12px', overflow:'hidden', border:'1px dashed #555'}}
                      onDragOver={e=>{e.preventDefault(); e.stopPropagation();}}
                      onDrop={e=>{e.preventDefault(); e.stopPropagation(); uploadAnnouncementPopupImage(e.dataTransfer.files[0]);}}>
                      <input type="file" accept="image/*" style={{display:'none'}} onChange={e=>{ uploadAnnouncementPopupImage(e.target.files[0]); e.target.value=''; }} />
                      {announcementPopupSaving
                        ? <div className="img-uploading"><div className="img-spin"></div></div>
                        : announcementPopup.image
                          ? <img src={announcementPopup.image} style={{width:'100%', height:'100%', objectFit:'cover'}} alt="" />
                          : <div style={{pointerEvents:'none', fontSize:'12px', textAlign:'center', color:'#999', padding:'32px 12px'}}>拖拽 / 点击上传通知附图<br/><span style={{color:'#666'}}>选填，建议克制配图</span></div>}
                    </label>
                    {announcementPopup.image ? (
                      <button type="button" onClick={()=>setAnnouncementPopup(prev=>({...prev, image:''}))} style={{marginTop:'8px', fontSize:'11px', color:'#ff7875', background:'none', border:'none', cursor:'pointer', padding:0}}>移除图片</button>
                    ) : null}
                  </div>
                  <div style={{flex:1, minWidth:'280px', display:'flex', flexDirection:'column', gap:'16px'}}>
                    <div>
                      <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>通知标题</label>
                      <input className="glow-input" value={announcementPopup.title} onChange={e=>setAnnouncementPopup({...announcementPopup, title: e.target.value})} placeholder="例如：平台公告" />
                    </div>
                    <div>
                      <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>通知正文</label>
                      <textarea className="glow-input" value={announcementPopup.content} onChange={e=>setAnnouncementPopup({...announcementPopup, content: e.target.value})} placeholder="填写要展示给访客的通知内容" style={{minHeight:'130px', lineHeight:1.7}} />
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => announcementPopupEditing ? saveAnnouncementPopup({ includeContent: true, enabled: true }) : saveAnnouncementPopup({ includeContent: true })}
                  disabled={announcementPopupSaving}
                  style={{width:'100%', padding:'18px', background: announcementPopupSaving ? '#333' : '#fff', color: announcementPopupSaving ? '#666' : '#000', border:'none', borderRadius:'12px', fontWeight:'bold', fontSize:'15px', cursor: announcementPopupSaving ? 'wait' : 'pointer', marginTop:'32px'}}
                >
                  {announcementPopupSaving ? '保存中…' : '保存公告弹窗'}
                </button>
                </>
                )}
              </>
            )}
          </div>
        ) : view === 'click-ad' ? (
          <div style={{background: '#424242', padding: 30, borderRadius: 20}}>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'22px'}}>
              <div style={{fontSize:'20px', fontWeight:'bold', color:'#fff'}}>🖱️ 遮罩广告</div>
              <div style={{fontSize:'12px', color:'#888'}}>仅首页 · 每天首次有效点击触发一次</div>
            </div>

            {adsLocked ? (
              <div style={ADS_LOCKED_NOTICE_STYLE}>广告位为专业版权益，升级后可用</div>
            ) : null}

            {clickAdLoading ? (
              <div style={{color:'#888', textAlign:'center', padding:'30px'}}>加载中...</div>
            ) : (
              <div style={{ opacity: adsLocked ? 0.55 : 1 }}>
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'20px', padding:'22px 24px', background:'#333', borderRadius:'14px', border:'1px solid #555', marginBottom:'18px'}}>
                  <div>
                    <div style={{fontSize:'16px', fontWeight:'bold', color:'#fff', marginBottom:'6px'}}>广告开关</div>
                    <div style={{fontSize:'12px', color:'#999'}}>
                      {clickAd.enabled ? '当前：已开启 · 不拦截原点击；排除贩售机与弹窗' : clickAdEditing ? '当前：已关闭 · 修改未保存' : '当前：已关闭'}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={clickAdSaving || adsLocked}
                    onClick={() => {
                      if (clickAd.enabled) { saveClickAd({ enabled: false }); return; }
                      if (clickAdEditing) { discardClickAdEditing(); return; }
                      startClickAdEditing();
                    }}
                    title={clickAdEditing ? '放弃修改并收起' : undefined}
                    style={{
                      minWidth: '88px',
                      padding: '12px 20px',
                      border: 'none',
                      borderRadius: '999px',
                      fontWeight: 'bold',
                      fontSize: '14px',
                      cursor: adsLocked ? 'not-allowed' : clickAdSaving ? 'wait' : 'pointer',
                      background: adsLocked ? '#444' : clickAd.enabled ? '#22c55e' : clickAdEditing ? '#d97706' : '#555',
                      color: '#fff',
                      opacity: adsLocked ? 0.5 : clickAdSaving ? 0.6 : 1,
                    }}
                  >
                    {clickAdSaving ? '保存中…' : (clickAd.enabled ? '已开启' : clickAdEditing ? '未保存' : '已关闭')}
                  </button>
                </div>
                {(clickAd.enabled || clickAdEditing) && (
                <>
                <div style={{display:'flex', flexDirection:'column', gap:'16px'}}>
                  <div>
                    <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>备注名 <span style={{color:'#777', fontWeight:'normal'}}>(可选)</span></label>
                    <input className="glow-input" value={clickAd.title} disabled={adsLocked} onChange={e=>setClickAd({...clickAd, title: e.target.value})} placeholder="例如：首页遮罩推广" />
                  </div>
                  <div>
                    <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>广告链接 <span style={{color:'#ff4d4f'}}>*</span></label>
                    <input className="glow-input" value={clickAd.url} disabled={adsLocked} onChange={e=>setClickAd({...clickAd, url: e.target.value})} placeholder="https://example.com" />
                  </div>
                  <div style={{fontSize:'12px', color:'#888', lineHeight:1.7, padding:'14px 16px', background:'#2f2f33', borderRadius:'10px'}}>
                    访客在第一次点击任意位置时会触发广告跳转。
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => clickAdEditing ? saveClickAd({ enabled: true }) : saveClickAd()}
                  disabled={clickAdSaving || adsLocked}
                  style={{width:'100%', padding:'18px', background: clickAdSaving || adsLocked ? '#333' : '#fff', color: clickAdSaving || adsLocked ? '#666' : '#000', border:'none', borderRadius:'12px', fontWeight:'bold', fontSize:'15px', cursor: adsLocked ? 'not-allowed' : clickAdSaving ? 'wait' : 'pointer', marginTop:'32px'}}
                >
                  {clickAdSaving ? '保存中…' : '保存遮罩广告'}
                </button>
                </>
                )}
              </div>
            )}
          </div>
        ) : view === 'popup-ad' ? (
          <div style={{background: '#424242', padding: 30, borderRadius: 20}}>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'22px'}}>
              <div style={{fontSize:'20px', fontWeight:'bold', color:'#fff'}}>🪟 弹窗广告</div>
              <div style={{fontSize:'12px', color:'#888'}}>仅首页 · 每个浏览器会话弹一次</div>
            </div>

            {adsLocked ? (
              <div style={ADS_LOCKED_NOTICE_STYLE}>广告位为专业版权益，升级后可用</div>
            ) : null}

            {popupAdLoading ? (
              <div style={{color:'#888', textAlign:'center', padding:'30px'}}>加载中...</div>
            ) : (
              <div style={{ opacity: adsLocked ? 0.55 : 1 }}>
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'20px', padding:'22px 24px', background:'#333', borderRadius:'14px', border:'1px solid #555', marginBottom:'18px'}}>
                  <div>
                    <div style={{fontSize:'16px', fontWeight:'bold', color:'#fff', marginBottom:'6px'}}>广告开关</div>
                    <div style={{fontSize:'12px', color:'#999'}}>
                      {popupAd.enabled ? '当前：已开启 · 与公告同时开启时先公告后广告' : popupAdEditing ? '当前：已关闭 · 修改未保存' : '当前：已关闭'}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={popupAdSaving || adsLocked}
                    onClick={() => {
                      if (popupAd.enabled) { savePopupAd({ enabled: false }); return; }
                      if (popupAdEditing) { discardPopupAdEditing(); return; }
                      startPopupAdEditing();
                    }}
                    title={popupAdEditing ? '放弃修改并收起' : undefined}
                    style={{
                      minWidth: '88px',
                      padding: '12px 20px',
                      border: 'none',
                      borderRadius: '999px',
                      fontWeight: 'bold',
                      fontSize: '14px',
                      cursor: adsLocked ? 'not-allowed' : popupAdSaving ? 'wait' : 'pointer',
                      background: adsLocked ? '#444' : popupAd.enabled ? '#22c55e' : popupAdEditing ? '#d97706' : '#555',
                      color: '#fff',
                      opacity: adsLocked ? 0.5 : popupAdSaving ? 0.6 : 1,
                    }}
                  >
                    {popupAdSaving ? '保存中…' : (popupAd.enabled ? '已开启' : popupAdEditing ? '未保存' : '已关闭')}
                  </button>
                </div>
                {(popupAd.enabled || popupAdEditing) && (
                <>
                <div style={{display:'flex', gap:'24px', alignItems:'flex-start', flexWrap:'wrap'}}>
                  <div>
                    <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'8px'}}>主图 <span style={{color:'#777', fontWeight:'normal'}}>(建议)</span></label>
                    <label className="img-drop" style={{width:'280px', height:'158px', minHeight:'158px', padding:0, borderRadius:'12px', overflow:'hidden', border:'1px dashed #555', cursor: adsLocked ? 'not-allowed' : 'pointer'}}
                      onDragOver={e=>{e.preventDefault(); e.stopPropagation();}}
                      onDrop={e=>{e.preventDefault(); e.stopPropagation(); uploadPopupAdImage(e.dataTransfer.files[0]);}}>
                      <input type="file" accept="image/*" style={{display:'none'}} disabled={adsLocked} onChange={e=>{ uploadPopupAdImage(e.target.files[0]); e.target.value=''; }} />
                      {popupAdSaving
                        ? <div className="img-uploading"><div className="img-spin"></div></div>
                        : popupAd.image
                          ? <img src={popupAd.image} style={{width:'100%', height:'100%', objectFit:'cover'}} alt="" />
                          : <div style={{pointerEvents:'none', fontSize:'12px', textAlign:'center', color:'#999', padding:'40px 12px'}}>拖拽 / 点击上传广告主图<br/><span style={{color:'#666'}}>建议 16:9</span></div>}
                    </label>
                    {popupAd.image ? (
                      <button type="button" disabled={adsLocked} onClick={()=>setPopupAd(prev=>({...prev, image:''}))} style={{marginTop:'8px', fontSize:'11px', color:'#ff7875', background:'none', border:'none', cursor: adsLocked ? 'not-allowed' : 'pointer', padding:0}}>移除图片</button>
                    ) : null}
                  </div>
                  <div style={{flex:1, minWidth:'280px', display:'flex', flexDirection:'column', gap:'16px'}}>
                    <div>
                      <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>广告标题</label>
                      <input className="glow-input" value={popupAd.title} disabled={adsLocked} onChange={e=>setPopupAd({...popupAd, title: e.target.value})} placeholder="例如：限时活动" />
                    </div>
                    <div>
                      <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>广告文案</label>
                      <textarea className="glow-input" value={popupAd.content} disabled={adsLocked} onChange={e=>setPopupAd({...popupAd, content: e.target.value})} placeholder="一行卖点说明" style={{minHeight:'90px', lineHeight:1.7}} />
                    </div>
                    <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:'12px'}}>
                      <div>
                        <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>按钮文字</label>
                        <input className="glow-input" value={popupAd.buttonText} disabled={adsLocked} onChange={e=>setPopupAd({...popupAd, buttonText: e.target.value})} placeholder="了解详情" />
                      </div>
                      <div>
                        <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>跳转链接 <span style={{color:'#ff4d4f'}}>*</span></label>
                        <input className="glow-input" value={popupAd.buttonUrl} disabled={adsLocked} onChange={e=>setPopupAd({...popupAd, buttonUrl: e.target.value})} placeholder="https://example.com" />
                      </div>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => popupAdEditing ? savePopupAd({ enabled: true }) : savePopupAd()}
                  disabled={popupAdSaving || adsLocked}
                  style={{width:'100%', padding:'18px', background: popupAdSaving || adsLocked ? '#333' : '#fff', color: popupAdSaving || adsLocked ? '#666' : '#000', border:'none', borderRadius:'12px', fontWeight:'bold', fontSize:'15px', cursor: adsLocked ? 'not-allowed' : popupAdSaving ? 'wait' : 'pointer', marginTop:'32px'}}
                >
                  {popupAdSaving ? '保存中…' : '保存弹窗广告'}
                </button>
                </>
                )}
              </div>
            )}
          </div>
        ) : view === 'gallery-ad' ? (
          <div style={{background: '#424242', padding: 30, borderRadius: 20}}>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'22px'}}>
              <div style={{fontSize:'20px', fontWeight:'bold', color:'#fff'}}>📢 内页广告位</div>
              <div style={{fontSize:'12px', color:'#888'}}>全主题文章内页底部横幅</div>
            </div>

            {adsLocked ? (
              <div style={ADS_LOCKED_NOTICE_STYLE}>广告位为专业版权益，升级后可用</div>
            ) : null}

            {galleryAdLoading ? (
              <div style={{color:'#888', textAlign:'center', padding:'30px'}}>加载中...</div>
            ) : (
              <div style={{ opacity: adsLocked ? 0.55 : 1 }}>
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'20px', padding:'22px 24px', background:'#333', borderRadius:'14px', border:'1px solid #555', marginBottom:'18px'}}>
                  <div>
                    <div style={{fontSize:'16px', fontWeight:'bold', color:'#fff', marginBottom:'6px'}}>广告位开关</div>
                    <div style={{fontSize:'12px', color:'#999'}}>
                      {galleryAd.enabled ? '当前：已开启 · 生效于 Gallery / Tweet / Standard 全主题文章页' : galleryAdEditing ? '当前：已关闭 · 修改未保存' : '当前：已关闭'}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={galleryAdSaving || adsLocked}
                    onClick={() => {
                      if (galleryAd.enabled) { saveGalleryAd({ enabled: false }); return; }
                      if (galleryAdEditing) { discardGalleryAdEditing(); return; }
                      startGalleryAdEditing();
                    }}
                    title={galleryAdEditing ? '放弃修改并收起' : undefined}
                    style={{
                      minWidth: '88px',
                      padding: '12px 20px',
                      border: 'none',
                      borderRadius: '999px',
                      fontWeight: 'bold',
                      fontSize: '14px',
                      cursor: adsLocked ? 'not-allowed' : galleryAdSaving ? 'wait' : 'pointer',
                      background: adsLocked ? '#444' : galleryAd.enabled ? '#22c55e' : galleryAdEditing ? '#d97706' : '#555',
                      color: '#fff',
                      opacity: adsLocked ? 0.5 : galleryAdSaving ? 0.6 : 1,
                    }}
                  >
                    {galleryAdSaving ? '保存中…' : (galleryAd.enabled ? '已开启' : galleryAdEditing ? '未保存' : '已关闭')}
                  </button>
                </div>
                {(galleryAd.enabled || galleryAdEditing) && (
                <>
                <div style={{fontSize:'12px', color:'#aaa', marginBottom:'20px', lineHeight:1.8}}>
                  开启后横幅显示在全主题文章内页底部，链接必填，背景图优先使用下方上传的 Banner图，未上传则自动抓取链接预览图。
                </div>
                <div style={{display:'flex', gap:'24px', alignItems:'flex-start', flexWrap:'wrap'}}>
                  <div>
                    <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'8px'}}>Banner 背景图 <span style={{color:'#777', fontWeight:'normal'}}>(选填)</span></label>
                    <label className="img-drop" style={{width:'280px', height:'56px', minHeight:'56px', padding:0, borderRadius:'8px', overflow:'hidden', border:'1px dashed #555', cursor: adsLocked ? 'not-allowed' : 'pointer'}}
                      onDragOver={e=>{e.preventDefault(); e.stopPropagation();}}
                      onDrop={e=>{e.preventDefault(); e.stopPropagation(); uploadGalleryAdCover(e.dataTransfer.files[0]);}}>
                      <input type="file" accept="image/*" style={{display:'none'}} disabled={adsLocked} onChange={e=>{ uploadGalleryAdCover(e.target.files[0]); e.target.value=''; }} />
                      {galleryAdCoverUploading
                        ? <div className="img-uploading"><div className="img-spin"></div></div>
                        : galleryAd.cover
                          ? <img src={galleryAd.cover} style={{width:'100%', height:'100%', objectFit:'cover'}} alt="" />
                          : <div style={{pointerEvents:'none', fontSize:'11px', textAlign:'center', color:'#999', padding:'10px'}}>拖拽 / 点击上传横版 Banner<br/><span style={{color:'#666'}}>建议宽图，前台高度约 40px</span></div>}
                    </label>
                    {galleryAd.cover ? (
                      <button type="button" disabled={adsLocked} onClick={()=>setGalleryAd(prev=>({...prev, cover:''}))} style={{marginTop:'8px', fontSize:'11px', color:'#ff7875', background:'none', border:'none', cursor: adsLocked ? 'not-allowed' : 'pointer', padding:0}}>移除 Banner 图</button>
                    ) : null}
                  </div>
                  <div style={{flex:1, minWidth:'280px', display:'flex', flexDirection:'column', gap:'16px'}}>
                    <div>
                      <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>广告链接 <span style={{color:'#ff4d4f'}}>*</span></label>
                      <input className="glow-input" value={galleryAd.url} disabled={adsLocked} onChange={e=>setGalleryAd({...galleryAd, url: e.target.value})} placeholder="https://example.com" />
                    </div>
                    <div>
                      <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>宣传文字（选填）</label>
                      <input className="glow-input" value={galleryAd.promoText} disabled={adsLocked} onChange={e=>setGalleryAd({...galleryAd, promoText: e.target.value})} placeholder="留空则仅显示链接预览背景图" />
                    </div>
                  </div>
                </div>
                <div style={{display:'flex', gap:'12px', marginTop:'32px'}}>
                  <button onClick={() => galleryAdEditing ? saveGalleryAd({ enabled: true }) : saveGalleryAd()} disabled={galleryAdSaving || adsLocked} style={{flex:1, padding:'18px', background: galleryAdSaving || adsLocked ? '#333' : '#fff', color: galleryAdSaving || adsLocked ? '#666' : '#000', border:'none', borderRadius:'12px', fontWeight:'bold', fontSize:'15px', cursor: adsLocked ? 'not-allowed' : galleryAdSaving ? 'wait' : 'pointer'}}>
                    {galleryAdSaving ? '保存中...' : '保存广告位'}
                  </button>
                  {galleryAd.id ? (
                    <button onClick={clearGalleryAd} disabled={galleryAdSaving || adsLocked} style={{padding:'18px 24px', background:'transparent', color:'#ff7875', border:'1px solid #ff7875', borderRadius:'12px', fontWeight:'bold', fontSize:'14px', cursor: adsLocked ? 'not-allowed' : 'pointer'}}>清空</button>
                  ) : null}
                </div>
                </>
                )}
              </div>
            )}
          </div>
        ) : view === 'stats' ? (
          /* 派工单 B3:数据统计面板(自包含组件,挂载时拉取,失败显示暂无数据) */
          <StatsPanel />
        ) : view === 'friends' ? (
          <div style={{background: '#424242', padding: 30, borderRadius: 20}}>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'22px'}}>
              <div style={{fontSize:'20px', fontWeight:'bold', color:'#fff'}}>🔗 友链管理</div>
              <div style={{fontSize:'12px', color:'#888'}}>共 {friends.length} 个友链</div>
            </div>

            {/* 添加新友链 */}
            <div style={{background:'#333', padding:'20px', borderRadius:'12px', marginBottom:'25px'}}>
              <div style={{fontSize:'13px', color:'greenyellow', marginBottom:'14px', fontWeight:'bold'}}>＋ 添加新友链</div>
              <div style={{display:'flex', gap:'16px', alignItems:'flex-start', flexWrap:'wrap'}}>
                <label className="img-drop" style={{width:'88px', height:'88px', minHeight:'88px', flexShrink:0, padding:0, borderRadius:'50%', overflow:'hidden'}}
                  onDragOver={e=>{e.preventDefault(); e.stopPropagation();}}
                  onDrop={e=>{e.preventDefault(); e.stopPropagation(); uploadDraftAvatar(e.dataTransfer.files[0]);}}>
                  <input type="file" accept="image/*" style={{display:'none'}} onChange={e=>{ uploadDraftAvatar(e.target.files[0]); e.target.value=''; }} />
                  {friendDraftUploading
                    ? <div className="img-uploading"><div className="img-spin"></div></div>
                    : friendDraft.avatar
                      ? <img src={friendDraft.avatar} style={{width:'100%', height:'100%', objectFit:'cover'}} alt="" />
                      : <div style={{pointerEvents:'none', fontSize:'11px', textAlign:'center', color:'#999'}}>拖拽/点击<br/>上传图标</div>}
                </label>
                <div style={{flex:1, minWidth:'240px', display:'flex', flexDirection:'column', gap:'10px'}}>
                  <input className="glow-input" placeholder="站点名称" value={friendDraft.name} onChange={e=>setFriendDraft({...friendDraft, name:e.target.value})} />
                  <input className="glow-input" placeholder="站点链接 https://..." value={friendDraft.url} onChange={e=>setFriendDraft({...friendDraft, url:e.target.value})} style={{fontSize:'13px'}} />
                  <div><button onClick={()=>saveFriend(friendDraft)} disabled={friendBtnStatus['draft']==='saving'} style={{background: friendBtnStatus['draft']==='done' ? '#4dab6d' : 'greenyellow', color: friendBtnStatus['draft']==='done' ? '#fff' : '#000', border:'none', padding:'9px 22px', borderRadius:'8px', fontWeight:'bold', cursor: friendBtnStatus['draft']==='saving'?'not-allowed':'pointer', minWidth:'130px', display:'inline-flex', alignItems:'center', justifyContent:'center', gap:'8px', transition:'background 0.3s'}}>
                    {friendBtnStatus['draft']==='saving' ? <><span style={btnSpinStyle}></span>处理中...</> : friendBtnStatus['draft']==='done' ? '✓ 添加成功' : '添加友链'}
                  </button></div>
                </div>
              </div>
            </div>

            {/* 现有友链列表 */}
            {friendsLoading && friends.length === 0 && <div style={{color:'#888', textAlign:'center', padding:'20px'}}>加载中...</div>}
            <div style={{display:'flex', flexDirection:'column', gap:'12px'}}>
              {friends.map(f => (
                <div key={f.id} style={{display:'flex', gap:'14px', alignItems:'center', background:'#333', padding:'14px', borderRadius:'10px'}}>
                  <label className="img-drop" style={{width:'64px', height:'64px', minHeight:'64px', flexShrink:0, padding:0, borderRadius:'50%', overflow:'hidden'}}
                    onDragOver={e=>{e.preventDefault(); e.stopPropagation();}}
                    onDrop={e=>{e.preventDefault(); e.stopPropagation(); uploadFriendAvatar(f.id, e.dataTransfer.files[0]);}}>
                    <input type="file" accept="image/*" style={{display:'none'}} onChange={e=>{ uploadFriendAvatar(f.id, e.target.files[0]); e.target.value=''; }} />
                    {f._uploading
                      ? <div className="img-uploading"><div className="img-spin"></div></div>
                      : f.avatar
                        ? <img src={f.avatar} style={{width:'100%', height:'100%', objectFit:'cover'}} alt="" />
                        : <div style={{pointerEvents:'none', fontSize:'10px', textAlign:'center', color:'#999'}}>无图标</div>}
                  </label>
                  <div style={{flex:1, display:'flex', flexDirection:'column', gap:'8px'}}>
                    <input className="glow-input" value={f.name} onChange={e=>updateFriendField(f.id, 'name', e.target.value)} placeholder="站点名称" />
                    <input className="glow-input" value={f.url} onChange={e=>updateFriendField(f.id, 'url', e.target.value)} placeholder="站点链接" style={{fontSize:'13px'}} />
                  </div>
                  <div style={{display:'flex', flexDirection:'column', gap:'8px'}}>
                    <button onClick={()=>saveFriend(f)} disabled={friendBtnStatus[f.id]==='saving'} style={{background: friendBtnStatus[f.id]==='done' ? '#4dab6d' : 'greenyellow', color: friendBtnStatus[f.id]==='done' ? '#fff' : '#000', border:'none', padding:'7px 16px', borderRadius:'8px', fontWeight:'bold', cursor: friendBtnStatus[f.id]==='saving'?'not-allowed':'pointer', minWidth:'92px', display:'inline-flex', alignItems:'center', justifyContent:'center', gap:'6px', transition:'background 0.3s'}}>
                      {friendBtnStatus[f.id]==='saving' ? <><span style={btnSpinStyle}></span>保存中</> : friendBtnStatus[f.id]==='done' ? '✓ 已保存' : '保存'}
                    </button>
                    <button onClick={()=>deleteFriend(f.id)} style={{background:'#ff4d4f', color:'#fff', border:'none', padding:'7px 16px', borderRadius:'8px', fontWeight:'bold', cursor:'pointer'}}>删除</button>
                  </div>
                </div>
              ))}
              {!friendsLoading && friends.length === 0 && <div style={{textAlign:'center', color:'#666', padding:'40px', border:'2px dashed #444', borderRadius:'12px'}}>还没有友链，在上方添加吧</div>}
            </div>
          </div>
        ) : view === 'drafts' ? (
          /* 🗂 Phase4: 统一草稿箱——本地快照 */
          <div style={{background: '#424242', padding: 30, borderRadius: 20}}>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'24px', gap:'12px', flexWrap:'wrap'}}>
              <div style={{fontSize:'20px', fontWeight:'bold', color:'#fff'}}>草稿箱</div>
              <div style={{fontSize:'12px', color:'#888'}}>本地草稿 {draftSnapshots.length} 份</div>
            </div>

            {draftSnapshots.length === 0 ? (
              <div style={{textAlign:'center', color:'#666', padding:'40px', border:'2px dashed #444', borderRadius:'12px'}}>暂无草稿</div>
            ) : (
              <>
                <div style={{fontSize:'13px', color:'greenyellow', marginBottom:'14px', fontWeight:'bold'}}>草稿</div>
                {draftSnapshots.length === 0 ? (
                  <div style={{textAlign:'center', color:'#666', padding:'26px', border:'2px dashed #444', borderRadius:'12px', marginBottom:'28px'}}>暂无草稿</div>
                ) : (
                  <div style={{display:'flex', flexDirection:'column', gap:'12px', marginBottom:'28px'}}>
                    {draftSnapshots.map((s) => (
                      <div key={s.id} style={{display:'flex', gap:'14px', alignItems:'center', background:'#333', padding:'14px 16px', borderRadius:'10px', flexWrap:'wrap'}}>
                        <div style={{flex:1, minWidth:'220px', display:'flex', flexDirection:'column', gap:'6px'}}>
                          <div style={{display:'flex', alignItems:'center', gap:'8px', flexWrap:'wrap'}}>
                            <span style={{fontWeight:'bold', color:'#fff', fontSize:'14px', wordBreak:'break-all'}}>{s.title || '未命名'}</span>
                            {s.kind === 'failed' ? (
                              <span style={{fontSize:'10.5px', padding:'2px 8px', borderRadius:'999px', background:'rgba(251,191,36,0.15)', color:'#fbbf24', border:'1px solid rgba(251,191,36,0.45)'}}>⚠️ 发布失败</span>
                            ) : (
                              <span style={{fontSize:'10.5px', padding:'2px 8px', borderRadius:'999px', background:'rgba(173,255,47,0.12)', color:'#9acd32', border:'1px solid rgba(173,255,47,0.35)'}}>💾 手动保存</span>
                            )}
                          </div>
                          <div style={{fontSize:'11.5px', color:'#888'}}>
                            {formatDraftSnapshotTime(s.createdAt)}{s.slug ? ` · ${s.slug}` : ''}{s.postId ? ' · 已关联文章' : ' · 新文章'}
                          </div>
                        </div>
                        <div style={{display:'flex', gap:'8px'}}>
                          <button onClick={() => restoreDraftFromBox(s.id)} style={{background:'greenyellow', color:'#000', border:'none', padding:'7px 16px', borderRadius:'8px', fontWeight:'bold', cursor:'pointer'}}>恢复编辑</button>
                          <button onClick={() => deleteDraftSnapshot(s.id)} style={{background:'#555', color:'#eee', border:'none', padding:'7px 16px', borderRadius:'8px', fontWeight:'bold', cursor:'pointer'}}>删除</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        ) : form.type === 'Widget' ? (
          /* 🧩 组件编辑：精简界面，仅 标题 / 摘要 / 头像 */
          <div style={{background: '#424242', padding: 30, borderRadius: 20}}>
            <div style={{fontSize:'20px', fontWeight:'bold', color:'#fff', marginBottom:'6px'}}>🧩 网站信息编辑</div>
            <div style={{fontSize:'12px', color:'#888', marginBottom:'26px', lineHeight:1.7}}>该组件用于展示站点头像、标题与简介。</div>
            <div style={{display:'flex', gap:'26px', alignItems:'flex-start', flexWrap:'wrap'}}>
              <div>
                <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'8px'}}>站点头像</label>
                <label className="img-drop" style={{width:'120px', height:'120px', minHeight:'120px', padding:0, borderRadius:'16px', overflow:'hidden'}}
                  onDragOver={e=>{e.preventDefault(); e.stopPropagation();}}
                  onDrop={e=>{e.preventDefault(); e.stopPropagation(); uploadCover(e.dataTransfer.files[0]);}}>
                  <input type="file" accept="image/*" style={{display:'none'}} onChange={e=>{ uploadCover(e.target.files[0]); e.target.value=''; }} />
                  {coverUploading
                    ? <div className="img-uploading"><div className="img-spin"></div></div>
                    : form.cover
                      ? <img src={form.cover} style={{width:'100%', height:'100%', objectFit:'cover'}} alt="" />
                      : <div style={{pointerEvents:'none', fontSize:'12px', textAlign:'center', color:'#999'}}>拖拽 / 点击<br/>上传头像</div>}
                </label>
              </div>
              <div style={{flex:1, minWidth:'260px', display:'flex', flexDirection:'column', gap:'16px'}}>
                <div><label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>标题 <span style={{color:'#ff4d4f'}}>*</span></label><input className="glow-input" value={form.title} onChange={e=>setFormDirty({...form, title:e.target.value})} placeholder="组件标题..." /></div>
                <div><label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>摘要</label><textarea className="glow-input" value={form.excerpt} onChange={e=>setFormDirty({...form, excerpt:e.target.value})} placeholder="组件简介..." style={{minHeight:'90px'}} /></div>
              </div>
            </div>
            <button onClick={attemptSave} title={isFormValid ? '' : (getMissingFieldMsg() || '')} style={{width:'100%', padding:'20px', background:isFormValid?'#fff':'#222', color:isFormValid?'#000':'#666', border:'none', borderRadius:'12px', fontWeight:'bold', fontSize:'16px', marginTop:'12px', cursor:'pointer', transition:'0.3s'}}>保存修改</button>
          </div>
        ) : (
          /* 这里是之前的表单编辑代码... */
          <div className="editor-form-panel" style={{background: '#424242', padding: 30, borderRadius: 20}}>
            <StepAccordion step={1} title={<span style={{display:'inline-flex', alignItems:'center', gap:'8px'}}>基础信息<span style={{fontSize:'10px', color:'#ff4d4f', border:'1px solid rgba(255,77,79,0.5)', borderRadius:'4px', padding:'1px 6px', fontWeight:'bold'}}>必填</span></span>} isOpen={expandedStep === 1} onToggle={()=>setExpandedStep(expandedStep===1?0:1)}>
              <div style={{marginBottom:'15px'}}><label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>标题 <span style={{color: '#ff4d4f'}}>*</span></label><input className="glow-input" value={form.title} onChange={e=>setFormDirty({...form, title:e.target.value})} placeholder="输入标题" /></div>
                <div style={{marginBottom:'15px'}}><label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>摘要</label><input className="glow-input" value={form.excerpt} onChange={e=>setFormDirty({...form, excerpt:e.target.value})} placeholder="输入摘要" /></div>
               {!editingSimplePage ? (
               <div style={{marginTop:'4px', marginBottom:'0', paddingTop:'16px', borderTop:'1px solid #333'}}>
                 <label style={{display:'block', fontSize:'11px', color:'#fbbf24', marginBottom:'6px', fontWeight:'bold'}}>🔒 文章访问密码</label>
                 <p style={{fontSize:'11px', color:'#777', margin:'0 0 8px', lineHeight:1.5}}>填写后，读者点击文章卡片需输入密码才能查看正文。</p>
                 <input
                   className="glow-input"
                   type="password"
                   value={form.article_password || ''}
                   onChange={e=>setFormDirty({...form, article_password:e.target.value})}
                   placeholder="留空 = 不上锁"
                   style={{fontSize:'13px', maxWidth:'320px'}}
                   autoComplete="new-password"
                 />
                  {form.article_password?.trim() ? (
                    <p style={{fontSize:'11px', color:'#fbbf24', margin:'8px 0 0', lineHeight:1.5}}>当前文章已启用全篇加密。</p>
                  ) : null}
                 </div>
                 ) : null}
              </StepAccordion>
            <StepAccordion step={2} title={editingSimplePage ? '发布时间' : (<span style={{display:'inline-flex', alignItems:'center', gap:'8px'}}>分类与时间<span style={{fontSize:'10px', color:'#ff4d4f', border:'1px solid rgba(255,77,79,0.5)', borderRadius:'4px', padding:'1px 6px', fontWeight:'bold'}}>必填</span></span>)} isOpen={expandedStep === 2} onToggle={()=>setExpandedStep(expandedStep===2?0:2)}>
               <div className={`editor-step-grid ${editingSimplePage ? 'editor-step-grid--single' : 'editor-step-grid--dual'}`}>
                 {!editingSimplePage ? (
                 <div>
                   <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>分类 <span style={{color: '#ff4d4f'}}>*</span></label>
                   <CategoryPicker
                     value={form.category || ''}
                     categories={options.categories}
                     onChange={setCategory}
                     onRequestDelete={requestDeleteCategory}
                     onRenameCategory={renameCategory}
                   />
                   {showCatInput ? (
                     <div className="editor-cat-create-row">
                       <input autoFocus className="glow-input" style={{ flex: 1, padding: '8px 10px', fontSize: '13px' }} value={catDraft}
                         onChange={e=>setCatDraft(e.target.value)}
                         onKeyDown={e=>{ if(e.key==='Enter'){ e.preventDefault(); addCategoryFromDraft(); } else if(e.key==='Escape'){ setShowCatInput(false); setCatDraft(''); } }}
                         placeholder="输入新分类名" />
                       <button type="button" onClick={addCategoryFromDraft} style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid greenyellow', background: 'rgba(173,255,47,0.12)', color: 'greenyellow', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', whiteSpace: 'nowrap' }}>添加</button>
                       <button type="button" onClick={()=>{ setShowCatInput(false); setCatDraft(''); }} style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid #555', background: 'transparent', color: '#888', fontSize: '12px', cursor: 'pointer' }}>取消</button>
                     </div>
                   ) : (
                     <span onClick={()=>setShowCatInput(true)} style={{ display: 'inline-block', cursor:'pointer', border:'1px dashed #666', color:'greenyellow', padding:'6px 12px', borderRadius:'6px', fontSize:'13px' }}>＋ 创建分类</span>
                   )}
                 </div>
                 ) : null}
                  <div className="editor-date-field"><label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>发布日期 <span style={{color: '#ff4d4f'}}>*</span></label><input className="glow-input" type="date" value={form.date} onChange={e=>setFormDirty({...form, date:e.target.value})} /></div>
               </div>
            </StepAccordion>
{!editingSimplePage ? (
<StepAccordion step={3} title="标签" isOpen={expandedStep === 3} onToggle={()=>setExpandedStep(expandedStep===3?0:3)}>
               <div style={{marginBottom:'15px'}}>
                 <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'5px'}}>标签</label>
                 <div style={{display:'flex', flexWrap:'wrap', gap:'8px', alignItems:'center'}}>
                   {selectedTags.map(t => (
                     <span key={t} style={{display:'inline-flex', alignItems:'center', gap:'6px', background:'#333', padding:'6px 10px', borderRadius:'6px', fontSize:'13px', color:'#fff'}}>
                       {t}
                       <span onClick={()=>removeTag(t)} style={{cursor:'pointer', color:'#ff7875', fontWeight:'bold'}}>×</span>
                     </span>
                   ))}
                   {showTagInput ? (
                     <input autoFocus className="glow-input" style={{width:'150px', padding:'6px 10px'}} value={tagDraft}
                       onChange={e=>setTagDraft(e.target.value)}
                       onKeyDown={e=>{ if(e.key==='Enter'){ e.preventDefault(); addTag(tagDraft); setTagDraft(''); } else if(e.key==='Escape'){ setShowTagInput(false); setTagDraft(''); } }}
                       onBlur={()=>{ if(tagDraft.trim()) addTag(tagDraft); setTagDraft(''); setShowTagInput(false); }}
                       placeholder="输入标签后回车" />
                   ) : (
                     <span onClick={()=>setShowTagInput(true)} style={{cursor:'pointer', border:'1px dashed #666', color:'greenyellow', padding:'6px 12px', borderRadius:'6px', fontSize:'13px'}}>＋ 添加标签</span>
                   )}
                 </div>
                 {displayTags.filter(t=>!selectedTags.includes(t)).length > 0 && (
                   <div style={{marginTop:'12px'}}>
                     <div style={{fontSize:'11px', color:'#777', marginBottom:'6px'}}>点击已有标签快速添加：</div>
                     <div style={{display:'flex', flexWrap:'wrap', gap:'6px', alignItems:'center'}}>
                       {displayTags.filter(t=>!selectedTags.includes(t)).map(t => (
                         <span
                           key={t}
                           className="tag-suggest-chip"
                           onClick={()=>addTag(t)}
                         >
                           {t}
                           <span
                             className="tag-suggest-del"
                             title="永久删除此标签"
                             onClick={(e) => {
                               e.stopPropagation();
                               permanentlyDeleteTag(t);
                             }}
                           >
                             ×
                           </span>
                         </span>
                       ))}
                       {options.tags.length > 12 && <span onClick={()=>setShowAllTags(!showAllTags)} style={{fontSize:'12px', color:'greenyellow', cursor:'pointer', fontWeight:'bold'}}>{showAllTags ? '收起' : '更多...'}</span>}
                     </div>
                   </div>
                 )}
               </div>
            </StepAccordion>
) : null}

            {!editingSimplePage ? (
            <StepAccordion step={4} title="图库" isOpen={expandedStep === 4} onToggle={()=>setExpandedStep(expandedStep===4?0:4)}>
              <GalleryManager
                postSlug={form.slug}
                postTitle={form.title}
                postNotionId={currentId}
                items={galleryItems}
                onItemsChange={setGalleryItems}
                onGalleryMutated={() => { setGalleryDirty(true); markDirty(); }}
                coverMode={coverSettings.mode}
                coverIndex={galleryCoverIndex}
                onSetCover={handleSetGalleryCover}
                onClearCover={handleClearGalleryCover}
              />
            </StepAccordion>
            ) : null}

            {!editingSimplePage ? (
            <>
            <StepAccordion step={5} title={<>封面</>} isOpen={expandedStep === 5} onToggle={()=>setExpandedStep(expandedStep===5?0:5)}>
              <div style={{ marginBottom: '14px', padding: '14px', borderRadius: '10px', border: '1px solid #3a3a42', background: '#1a1a1e' }}>
                <BlockCoverHint
                  coverSettings={coverSettings}
                  coverStatusText={coverStatusText}
                  showManualCoverInput={showManualCoverInput}
                  onToggleDefaultCover={handleToggleDefaultCover}
                  onToggleManualInput={() => setShowManualCoverInput((v) => !v)}
                  onManualUrlChange={(url) => {
                    markDirty();
                    setCoverSettings((prev) => ({ ...prev, manualUrl: url }));
                  }}
                  onApplyManualUrl={handleApplyManualCoverUrl}
                />
              </div>
            </StepAccordion>
            <StepAccordion step={6} title={<>下载链接 <GalleryOnlyTag /></>} isOpen={expandedStep === 6} onToggle={()=>setExpandedStep(expandedStep===6?0:6)}>
               <div>
                 <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'6px'}}>下载链接 <GalleryOnlyTag /></label>
                 <p style={{fontSize:'11px', color:'#777', margin:'0 0 8px', lineHeight:1.5}}>Gallery 主题下载弹窗中展示的链接内容，留空则显示「暂无下载」。</p>
                  <input className="glow-input" value={form.download || ''} onChange={e=>setFormDirty({...form, download:e.target.value})} placeholder="例如：https://xxx.xxpan.com" style={{fontSize:'13px'}} />
                 <div style={{marginTop:'12px'}}>
                   <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'6px'}}>下载信息（数量） <GalleryOnlyTag /></label>
                    <input className="glow-input" value={form.download_count || ''} onChange={e=>setFormDirty({...form, download_count:e.target.value})} placeholder="例如：82P、50P+2v" style={{fontSize:'13px'}} />
                   <p style={{fontSize:'11px', color:'#777', margin:'6px 0 0', lineHeight:1.5}}>填写后显示在首页卡片封面右下角，留空则不显示。</p>
                 </div>
                  <div style={{marginTop:'12px'}}>
                    <label style={{display:'block', fontSize:'11px', color:'#bbb', marginBottom:'6px'}}>资源包大小 <GalleryOnlyTag /></label>
                     <input className="glow-input" value={form.download_size || ''} onChange={e=>setFormDirty({...form, download_size:e.target.value})} placeholder="例如：639 MB、1.2 GB" style={{fontSize:'13px'}} />
                    <p style={{fontSize:'11px', color:'#777', margin:'6px 0 0', lineHeight:1.5}}>填写后显示在下载页标题栏右侧，留空则不显示。</p>
                  </div>
                </div>
             </StepAccordion>
              {/* 存储基座 S3：文章附件（上传/列表/删除；读者在文章页可见下载按钮） */}
              {form.type !== 'Widget' ? (
              <StepAccordion step={7} title={<>附件</>} isOpen={expandedStep === 7} onToggle={()=>setExpandedStep(expandedStep===7?0:7)}>
                <AttachmentManager postSlug={form.slug} />
              </StepAccordion>
              ) : null}
               {form.type !== 'Widget' ? (
               <div style={{marginTop:'12px'}}>
                 {form.linked_product_sku ? (
                <div style={{marginBottom:'10px', padding:'12px 14px', borderRadius:'10px', border:'1px solid rgba(59,130,246,0.35)', background:'rgba(59,130,246,0.06)'}}>
                  <label style={{display:'block', fontSize:'11px', color:'#93c5fd', marginBottom:'6px'}}>已关联商品</label>
                  <p style={{fontSize:'12px', color:'#e5e5e5', margin:'0 0 8px', lineHeight:1.5, wordBreak:'break-all'}}>商品码：{form.linked_product_sku}</p>
                  <button type="button" onClick={()=>{ setFormDirty({...form, linked_product_sku: ''}); showAdminToast('已清除商品关联，保存后生效', 2600); }} style={{height:'32px', padding:'0 14px', borderRadius:'8px', cursor:'pointer', border:'1px solid rgba(239,68,68,0.6)', background:'rgba(239,68,68,0.12)', color:'#f87171', fontSize:'12px', fontWeight:'bold'}}>清除关联</button>
                </div>
                ) : null}
                <button type="button" onClick={openProductLookupModal}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#3b82f6'; e.currentTarget.style.boxShadow = '0 4px 16px rgba(37,99,235,0.45)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = '#2563eb'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(37,99,235,0.35)'; e.currentTarget.style.transform = 'none'; }}
                  onMouseDown={(e) => { e.currentTarget.style.transform = 'translateY(1px)'; }}
                  onMouseUp={(e) => { e.currentTarget.style.transform = 'none'; }}
                  style={{width:'100%', padding:'13px 14px', borderRadius:'12px', border:'none', background:'#2563eb', color:'#fff', fontSize:'13px', fontWeight:'bold', cursor:'pointer', transition:'background 0.2s, box-shadow 0.2s, transform 0.15s', display:'flex', alignItems:'center', justifyContent:'center', gap:'8px', boxShadow:'0 4px 12px rgba(37,99,235,0.35)'}}>
                   <span style={{fontSize:'15px', lineHeight:1}}>＋</span> 添加商品信息
                </button>
                {productLookup.open && (
                <div
                  onMouseDown={(e) => { if (e.target === e.currentTarget) setProductLookup((p) => ({ ...p, open: false })); }}
                  style={{ position:'fixed', inset:0, zIndex:10000, background:'rgba(0,0,0,0.55)', backdropFilter:'blur(2px)', display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}
                >
                   <div style={{ width:'100%', maxWidth:'420px', background:'#1f1f24', border:'1px solid #3a3a42', borderRadius:'14px', boxShadow:'0 12px 40px rgba(0,0,0,0.5)', padding:'22px' }}>
                     <div style={{ fontSize:'16px', fontWeight:'bold', color:'#fff', marginBottom:'4px' }}>添加商品信息</div>
                     {/* P18C45UI 批3:弹窗强调色统一蓝色(原粉红已改) */}
                     <div style={{ fontSize:'12px', color:'#93c5fd', marginBottom:'16px', lineHeight:1.6 }}>输入商品码并点击底部【关联商品】。</div>
                     <label style={{ display:'block', fontSize:'12px', color:'#bbb', marginBottom:'6px' }}>商品码（编号）</label>
                     <div style={{ marginBottom:'14px' }}>
                       <input
                         className="glow-input"
                         autoFocus
                         value={productLookup.sku}
                         onChange={(e) => setProductLookup((p) => ({ ...p, sku: e.target.value.toUpperCase(), result: null }))}
                         onKeyDown={(e) => { if (e.key === 'Enter' && !productLookup.loading) runProductLookupPrimary(); if (e.key === 'Escape') setProductLookup((p) => ({ ...p, open: false })); }}
                         placeholder="例如：MHDTNQUK"
                         style={{ width:'100%', fontSize:'13px', letterSpacing:'0.5px', textTransform:'uppercase' }}
                       />
                     </div>
                     {productLookup.loading ? (
                       <div style={{ padding:'10px 2px 4px', fontSize:'12px', color:'#bbb', lineHeight:1.6 }}>正在查询系统商品…（超时约 8s，请稍候）</div>
                     ) : productLookup.result ? (
                       productLookup.result.available && productLookup.result.product && isShopLookupProductOnSale(productLookup.result.product) ? (
                         <div style={{ padding:'12px 14px', borderRadius:'10px', border:'1px solid rgba(134,239,172,0.35)', background:'rgba(134,239,172,0.07)', marginBottom:'6px' }}>
                           <p style={{ fontSize:'13px', color:'#e5e5e5', margin:'0 0 6px', lineHeight:1.5 }}>商品名称：{productLookup.result.product.name || '—'}</p>
                           <p style={{ fontSize:'13px', color:'#e5e5e5', margin:'0 0 6px', lineHeight:1.5 }}>价格：{formatShopLookupPrice(productLookup.result.product.price)}</p>
                           <p style={{ fontSize:'13px', color:'#86efac', margin:'0', lineHeight:1.5 }}>状态：在售</p>
                         </div>
                       ) : (
                         <div style={{ padding:'10px 2px 4px', fontSize:'12px', color:'#ff6b6b', lineHeight:1.6 }}>
                           {productLookup.result.available
                             ? (productLookup.result.product
                                 ? `商品 ${productLookup.sku} 已下架，无法添加`
                                 : `商品码 ${productLookup.sku} 未找到，请核对后重试`)
                             : `系统商品查询失败（${lookupErrorText(productLookup.result.error)}），可稍后重试`}
                         </div>
                       )
                     ) : (
                       <div style={{ padding:'4px 2px', fontSize:'11px', color:'#777', lineHeight:1.6 }}>请确保您的商品已添加库存内容。</div>
                     )}
                     <div style={{ display:'flex', justifyContent:'flex-end', gap:'10px', marginTop:'16px' }}>
                       <button type="button" onClick={() => setProductLookup((p) => ({ ...p, open: false }))} style={{ height:'36px', padding:'0 16px', borderRadius:'8px', cursor:'pointer', border:'1px solid #444', background:'transparent', color:'#ccc', fontSize:'13px' }}>关闭</button>
                       {/* P18C45UI 批3:主按钮时序——「关联商品」(蓝)→查询中…→查到在售变「确认使用该商品」;
                           未找到/下架/异常保持「关联商品」不变确认 */}
                       <button
                         type="button"
                         onClick={runProductLookupPrimary}
                         disabled={productLookup.loading}
                         onMouseEnter={(e) => { if (productLookup.loading) return; e.currentTarget.style.background = '#3b82f6'; }}
                         onMouseLeave={(e) => { if (productLookup.loading) return; e.currentTarget.style.background = '#2563eb'; e.currentTarget.style.transform = 'none'; }}
                         onMouseDown={(e) => { if (productLookup.loading) return; e.currentTarget.style.transform = 'translateY(1px)'; }}
                         onMouseUp={(e) => { if (productLookup.loading) return; e.currentTarget.style.transform = 'none'; }}
                         data-testid="shop-lookup-primary-button"
                         style={{ height:'36px', padding:'0 18px', borderRadius:'8px', cursor: productLookup.loading ? 'wait' : 'pointer', border:'none', background: productLookup.loading ? '#555' : '#2563eb', color: productLookup.loading ? '#999' : '#fff', fontSize:'13px', fontWeight:'bold', transition:'background 0.2s, transform 0.15s' }}
                       >
                         {productLookup.loading ? '查询中…' : (productLookupConfirmable ? '确认使用该商品' : '关联商品')}
                       </button>
                     </div>
                   </div>
                </div>
                )}
              </div>
              ) : null}
             </>
             ) : null}

            <BlockBuilder
              blocks={editorBlocks}
              setBlocks={setEditorBlocksDirty}
              coverMode={coverSettings.mode}
              coverImageBlockId={editorBodyCoverBlockId}
              onSetBodyCover={handleSetBodyCover}
              onClearBodyCover={handleClearBodyCover}
              onToast={showAdminToast}
            />
            
            <div className="fab-scroll">
              <div className="fab-btn" onClick={() => scrollEditView('top')}><Icons.ArrowUp /></div>
              <div className="fab-btn" onClick={() => scrollEditView('bottom')}><Icons.ArrowDown /></div>
            </div>

            {formIsPostArticle ? (
              <button type="button" onClick={handleSaveDraftClick} disabled={loading} style={{width:'100%', padding:'13px', background:'#303030', color:'greenyellow', border:'1px solid rgba(173,255,47,0.45)', borderRadius:'12px', fontWeight:'bold', fontSize:'14px', marginTop:'56px', cursor: loading ? 'wait' : 'pointer', transition:'0.3s'}}>💾 存草稿（仅保存到本机，不上传）</button>
            ) : null}
            <button onClick={attemptSave} disabled={loading} title={isFormValid ? '' : (getMissingFieldMsg() || '')} style={{width:'100%', padding:'20px', background:isFormValid && !loading?'#fff':'#222', color:isFormValid && !loading?'#000':'#666', border:'none', borderRadius:'12px', fontWeight:'bold', fontSize:'16px', marginTop:'12px', cursor: loading ? 'wait' : 'pointer', transition:'0.3s'}}>
              {currentId ? '保存修改' : '确认发布'}
            </button>
          </div>
        )}
        {previewData && <div className="modal-bg" onClick={()=>setPreviewData(null)}><div className="modal-box" onClick={e=>e.stopPropagation()}><div style={{padding:'20px 25px', borderBottom:'1px solid #333', display:'flex', justifyContent:'space-between', alignItems:'center'}}><strong>预览: {previewData.title}</strong><button onClick={()=>setPreviewData(null)} style={{background:'none', border:'none', color:'#666', fontSize:'24px', cursor:'pointer'}}>×</button></div><div className="modal-body"><NotionView blocks={previewData.rawBlocks} /></div></div></div>}
      </div>
    </div>
  );
}
