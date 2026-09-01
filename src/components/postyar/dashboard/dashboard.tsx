"use client";
// ---------------------------------------------------------------------
// POSTYAR — Dashboard (revamp2 integration)
// ---------------------------------------------------------------------
// Wires every view built by the feature agents into a single collapsible
// sidebar shell. Item 4 (polish), Item 5 (collapsible submenus), Item 6
// (scroll-to-top on nav), Item 7 (decluttered home with inline KPI strip),
// Item 8 (3-tab stats lives in stats-view.tsx), Item 9 (subscription-gated
// menu via /api/me/usage planFeatures).
//
// Ad slots (other agents built these — we mount them):
//   - <StickyAdBar placement="sticky_bar" position="top" /> at the root.
//   - <AdSlot placement="user_dashboard_top" /> at the top of <main>.
//   - <AdSlot placement="user_dashboard_sidebar" /> at the bottom of the
//     desktop sidebar.
//
// New renderView cases wired in this integration:
//   - "training"              → <Training navigate={navigate} />  (landing agent)
//   - "admin-orders-review"   → <AdminOrdersReviewView navigate>  (orders agent)
//   (admin-ticket-departments: not a separate case — TicketDepartmentsManager
//    is already embedded inside admin/tickets.tsx.)
//
// All existing renderView cases are preserved unchanged.
// ---------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIcon,
  BarChart3Icon,
  BellIcon,
  BookOpenIcon,
  ChevronDownIcon,
  CreditCardIcon,
  FileTextIcon,
  GiftIcon,
  GraduationCapIcon,
  InboxIcon,
  LayoutGridIcon,
  ListOrderedIcon,
  LogOutIcon,
  MegaphoneIcon,
  MenuIcon,
  MessageCircleIcon,
  PackageIcon,
  PencilRulerIcon,
  PlusIcon,
  RadioIcon,
  RefreshCwIcon,
  SendIcon,
  ServerIcon,
  SettingsIcon,
  ShieldCheckIcon,
  ShoppingCartIcon,
  SparklesIcon,
  TicketIcon,
  TrendingUpIcon,
  UserCogIcon,
  UserIcon,
  UsersIcon,
  WalletIcon,
  Wand2Icon,
  ZapIcon,
  XIcon,
  BotIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/components/layout/session-provider";
import { Logo } from "@/components/layout/logo";
import { HeaderClock } from "@/components/layout/header-clock";
import { NotificationBell } from "@/components/layout/notification-bell";
import { AdSlot } from "@/components/layout/ad-slot";
import { StickyAdBar } from "@/components/layout/sticky-ad-bar";
import { cn } from "@/lib/utils";
import { toPersianDigits, formatJalaliDate } from "@/lib/persian";
import type { PlanFeatures, PlanBooleanFeatureKey } from "@/lib/payments/plan-catalog";

import StatsView from "@/components/postyar/dashboard/stats-view";
import AdminStatsView from "@/components/postyar/admin/stats";

import ContentManagerView from "@/components/postyar/content/view";
import ContentEditorView from "@/components/postyar/content/editor";
import DestinationsView from "@/components/postyar/destinations/view";
import GlassButtonsView from "@/components/postyar/destinations/glass-buttons";
import PlansView from "@/components/postyar/payment/plans";
import { NoPlanCheckout } from "@/components/postyar/payment/plans";
import PaymentView from "@/components/postyar/payment/view";
import OrdersView from "@/components/postyar/payment/orders";
import WalletView from "@/components/postyar/wallet/view";
import LedgerView from "@/components/postyar/wallet/ledger";
import ReferralView from "@/components/postyar/referral/view";
import SubscriptionsView from "@/components/postyar/payment/subscriptions";
import ProfileView from "@/components/postyar/dashboard/profile";
// Task 10-C views
import AiCaptionView from "@/components/postyar/ai/caption-view";
import AiTextView from "@/components/postyar/ai/text-view";
import SmartReplyView from "@/components/postyar/ai/smart-reply-view";
import AutoResponderView from "@/components/postyar/ai/auto-responder-view";
import InboxView from "@/components/postyar/ai/inbox-view";
import GoldView from "@/components/postyar/gold/view";
import GoldBotView from "@/components/postyar/gold/bot-view";
import WooView from "@/components/postyar/woo/view";
import TicketsView from "@/components/postyar/tickets/view";
import TicketDetailView from "@/components/postyar/tickets/detail";
import NotificationsView from "@/components/postyar/notifications/view";
import AdvertisingView from "@/components/postyar/advertising/view";
// Landing — training page (now private, embedded in the dashboard).
import { Training } from "@/components/postyar/landing/training";
// Task 10-D views — Bot Builder
import BotsListView from "@/components/postyar/bot/list";
import BotWorkflowView from "@/components/postyar/bot/workflow";
import BotLinkView from "@/components/postyar/bot/link";
import BotHistoryView from "@/components/postyar/bot/history";
import BotBroadcastView from "@/components/postyar/bot/broadcast";
// Task 10-D views — Admin Panel
import AdminUsersView from "@/components/postyar/admin/users";
import AdminPlansView from "@/components/postyar/admin/plans";
import AdminAuditView from "@/components/postyar/admin/audit";
import AdminHealthView from "@/components/postyar/admin/health";
import AdminAdsView from "@/components/postyar/admin/ads";
import AdminDiscountsView from "@/components/postyar/admin/discounts";
import AdminBankCardsView from "@/components/postyar/admin/bank-cards";
import AdminOrdersView from "@/components/postyar/admin/orders";
import AdminOrdersReviewView from "@/components/postyar/admin/orders-review";
import AdminSubscriptionsView from "@/components/postyar/admin/subscriptions";
import AdminBotsView from "@/components/postyar/admin/bots";
import AdminBroadcastView from "@/components/postyar/admin/broadcast";
import AdminSettingsView from "@/components/postyar/admin/settings";
import AdminTicketsView from "@/components/postyar/admin/tickets";
import AdminWooView from "@/components/postyar/admin/woo";
import AdminGoldView from "@/components/postyar/admin/gold";

export interface DashboardProps {
  navigate: (to: string) => void;
  initialView: string;
  param?: string;
}

// ---------------------------------------------------------------------
// Navigation model
// ---------------------------------------------------------------------
type NavGroupId =
  | "account"
  | "content"
  | "ai"
  | "bots"
  | "gold"
  | "admin";

interface NavItem {
  view: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  group: NavGroupId;
  adminOnly?: boolean;
  /** When set, the item is visible only if the user's active plan grants
   *  this feature (or the user is an admin). When absent, the item is
   *  always visible. Mirrors the FEATURE_CATALOG keys. */
  featureKey?: PlanBooleanFeatureKey;
}

const NAV: NavItem[] = [
  // ===== Group: account (always-on essentials + subscription items) =====
  { view: "home", label: "خانه", icon: LayoutGridIcon, group: "account" },
  { view: "stats", label: "آمار", icon: BarChart3Icon, group: "account", featureKey: "stats" },
  { view: "subscriptions", label: "اشتراک", icon: PackageIcon, group: "account" },
  { view: "plans", label: "پلن‌ها", icon: SparklesIcon, group: "account" },
  { view: "payment", label: "تسویه‌حساب", icon: CreditCardIcon, group: "account" },
  { view: "orders", label: "سفارش‌ها", icon: ListOrderedIcon, group: "account" },
  { view: "wallet", label: "کیف پول", icon: WalletIcon, group: "account", featureKey: "wallet" },
  { view: "ledger", label: "دفتر کل", icon: BookOpenIcon, group: "account", featureKey: "wallet" },
  { view: "referral", label: "معرفی دوستان", icon: GiftIcon, group: "account", featureKey: "referral" },
  { view: "advertising", label: "تبلیغات", icon: MegaphoneIcon, group: "account", featureKey: "advertising" },
  { view: "tickets", label: "تیکت‌ها", icon: TicketIcon, group: "account", featureKey: "tickets" },
  { view: "notifications", label: "اعلان‌ها", icon: BellIcon, group: "account" },
  { view: "profile", label: "پروفایل", icon: UserIcon, group: "account" },
  { view: "training", label: "آموزش", icon: GraduationCapIcon, group: "account" },
  // ===== Group: content (محتوا) =====
  { view: "content", label: "مدیریت محتوا", icon: FileTextIcon, group: "content", featureKey: "publish" },
  { view: "content-editor", label: "ویرایشگر محتوا", icon: SparklesIcon, group: "content", featureKey: "publish" },
  { view: "destinations", label: "مقاصد", icon: SendIcon, group: "content", featureKey: "multiChannel" },
  { view: "glass-buttons", label: "دکمه‌های شیشه‌ای", icon: LayoutGridIcon, group: "content", featureKey: "glassButtons" },
  { view: "woo", label: "ووکامرس", icon: ShoppingCartIcon, group: "content", featureKey: "woo" },
  // ===== Group: ai (هوش مصنوعی) =====
  { view: "ai-caption", label: "ساخت کپشن", icon: SparklesIcon, group: "ai", featureKey: "caption" },
  { view: "ai-text", label: "متن هوشمند", icon: Wand2Icon, group: "ai", featureKey: "smartText" },
  { view: "smart-reply", label: "پاسخ هوشمند", icon: MessageCircleIcon, group: "ai", featureKey: "smartReply" },
  { view: "auto-responder", label: "پاسخگوی خودکار", icon: ZapIcon, group: "ai", featureKey: "autoResponder" },
  { view: "inbox", label: "صندوق پیام‌ها", icon: InboxIcon, group: "ai", featureKey: "inbox" },
  // ===== Group: gold (طلا) =====
  { view: "gold", label: "قیمت طلا", icon: TrendingUpIcon, group: "gold", featureKey: "goldMonitor" },
  { view: "gold-bot", label: "بات طلا", icon: TrendingUpIcon, group: "gold", featureKey: "goldBot" },
  // ===== Group: bots (بات و اتوماسیون) =====
  { view: "bots", label: "بات‌ها", icon: BotIcon, group: "bots", featureKey: "bot" },
  { view: "bot-workflow", label: "گردش کار", icon: PencilRulerIcon, group: "bots", featureKey: "workflow" },
  { view: "bot-link", label: "کدهای اتصال", icon: RadioIcon, group: "bots", featureKey: "linkCodes" },
  { view: "bot-history", label: "تاریخچه ربات", icon: InboxIcon, group: "bots", featureKey: "bot" },
  { view: "bot-broadcast", label: "پیام گروهی", icon: SendIcon, group: "bots", featureKey: "broadcast" },
  // ===== Group: admin (مدیریت سامانه — adminOnly) =====
  { view: "admin-stats", label: "آمار سامانه", icon: BarChart3Icon, group: "admin", adminOnly: true },
  { view: "admin-users", label: "کاربران", icon: UsersIcon, group: "admin", adminOnly: true },
  { view: "admin-plans", label: "پلن‌ها", icon: PackageIcon, group: "admin", adminOnly: true },
  { view: "admin-audit", label: "ممیزی", icon: ShieldCheckIcon, group: "admin", adminOnly: true },
  { view: "admin-health", label: "وضعیت سامانه", icon: ActivityIcon, group: "admin", adminOnly: true },
  { view: "admin-ads", label: "تبلیغات", icon: MegaphoneIcon, group: "admin", adminOnly: true },
  { view: "admin-discounts", label: "تخفیف‌ها", icon: CreditCardIcon, group: "admin", adminOnly: true },
  { view: "admin-bank-cards", label: "کارت‌های بانکی", icon: CreditCardIcon, group: "admin", adminOnly: true },
  // New (revamp2-orders-wallet agent): better than the legacy admin-orders.
  { view: "admin-orders-review", label: "بازبینی سفارش‌ها", icon: ListOrderedIcon, group: "admin", adminOnly: true },
  { view: "admin-orders", label: "سفارش‌ها (قدیمی)", icon: ListOrderedIcon, group: "admin", adminOnly: true },
  { view: "admin-subscriptions", label: "اشتراک‌ها", icon: PackageIcon, group: "admin", adminOnly: true },
  { view: "admin-bots", label: "بات‌های سامانه", icon: BotIcon, group: "admin", adminOnly: true },
  { view: "admin-woo", label: "ووکامرس", icon: ShoppingCartIcon, group: "admin", adminOnly: true },
  { view: "admin-gold", label: "بات‌های طلا", icon: TrendingUpIcon, group: "admin", adminOnly: true },
  { view: "admin-broadcast", label: "اعلان گروهی", icon: MegaphoneIcon, group: "admin", adminOnly: true },
  { view: "admin-tickets", label: "تیکت‌ها", icon: TicketIcon, group: "admin", adminOnly: true },
  { view: "admin-settings", label: "تنظیمات", icon: SettingsIcon, group: "admin", adminOnly: true },
];

// ---------------------------------------------------------------------
// Collapsible group metadata
// ---------------------------------------------------------------------
interface NavGroupMeta {
  id: NavGroupId;
  label: string;
  adminOnly?: boolean;
  // When true, the group is expanded by default for new sessions.
  defaultOpen?: boolean;
}

const NAV_GROUPS: NavGroupMeta[] = [
  { id: "account", label: "حساب کاربری", defaultOpen: true },
  { id: "content", label: "محتوا" },
  { id: "ai", label: "هوش مصنوعی" },
  { id: "bots", label: "بات و اتوماسیون" },
  { id: "gold", label: "طلا" },
  { id: "admin", label: "مدیریت سامانه", adminOnly: true },
];

const NAV_GROUPS_STORAGE_KEY = "postyar_nav_groups";

// Persian role labels (addendum §23 — no Latin role string in UI).
// Technical identifiers remain Latin internally; only the rendered
// label is localized.
function roleFa(role: string | undefined | null): string {
  switch (role) {
    case "admin": return "مدیر";
    case "support": return "پشتیبان";
    case "user": return "کاربر";
    default: return "—";
  }
}

// ---------------------------------------------------------------------
// Feature gating
// ---------------------------------------------------------------------

/**
 * Decide whether a single nav item should be visible.
 *  - Admin users see EVERYTHING (all admin items + all user items
 *    regardless of plan).
 *  - Otherwise: visible if the item has no `featureKey` OR the user's
 *    active plan grants that feature.
 */
function isVisible(item: NavItem, isAdmin: boolean, features: PlanFeatures | null): boolean {
  if (item.adminOnly) return isAdmin;
  if (isAdmin) return true; // admin sees every user-facing module too
  if (!item.featureKey) return true;
  if (!features) return false;
  const v = features[item.featureKey];
  return typeof v === "boolean" ? v : false;
}

/**
 * Decide whether the user can access the current view (used to render the
 * upgrade card when they land on a gated view directly via URL).
 */
function isViewGranted(view: string, isAdmin: boolean, features: PlanFeatures | null): boolean {
  const item = NAV.find((n) => n.view === view);
  if (!item) return true; // unknown views fall through to NotImplemented
  return isVisible(item, isAdmin, features);
}

// ---------------------------------------------------------------------
// Collapsible nav group (Item 5)
// ---------------------------------------------------------------------
function NavGroup({
  group,
  items,
  active,
  onNavigate,
  open,
  onToggle,
}: {
  group: NavGroupMeta;
  items: NavItem[];
  active: string;
  onNavigate: (view: string) => void;
  open: boolean;
  onToggle: (id: NavGroupId) => void;
}) {
  if (items.length === 0) return null;
  const Icon = group.id === "account"
    ? UserCogIcon
    : group.id === "content"
      ? FileTextIcon
      : group.id === "ai"
        ? SparklesIcon
        : group.id === "bots"
          ? BotIcon
          : group.id === "gold"
            ? TrendingUpIcon
            : ServerIcon;
  return (
    <Collapsible open={open} onOpenChange={(v) => { if (v !== open) onToggle(group.id); }} dir="rtl">
      <CollapsibleTrigger
        className={cn(
          "group relative flex w-full items-center justify-between gap-2 rounded-lg border border-transparent px-3 py-2 text-xs font-semibold text-foreground transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:duration-200",
          open
            ? "border-primary/10 bg-gradient-to-l from-primary/10 via-primary/5 to-transparent text-foreground shadow-sm shadow-primary/5"
            : "hover:bg-muted/50 hover:border-border/60",
        )}
      >
        <span className="flex items-center gap-2">
          <span className={cn(
            "flex size-6 items-center justify-center rounded-md transition-colors",
            open ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary",
          )}>
            <Icon className="size-3.5" />
          </span>
          <span>{group.label}</span>
          <Badge variant="secondary" className="tabular-nums px-1.5 py-0 text-[10px]">
            {toPersianDigits(items.length)}
          </Badge>
        </span>
        <ChevronDownIcon
          className={cn(
            "size-4 transition-transform motion-safe:duration-200",
            open ? "rotate-180 text-primary" : "rotate-0 text-muted-foreground",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-1 ps-2 pt-1.5">
        {items.map((item) => (
          <NavLink key={item.view} item={item} active={active} onNavigate={onNavigate} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: string;
  onNavigate: (view: string) => void;
}) {
  const Icon = item.icon;
  const isActive = active === item.view;
  return (
    <button
      type="button"
      onClick={() => onNavigate(item.view)}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "nav-item-link group relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:duration-200",
        isActive
          ? "bg-gradient-to-l from-primary/15 via-primary/8 to-transparent text-primary font-medium shadow-sm shadow-primary/5 ring-1 ring-inset ring-primary/15"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <Icon className={cn("size-4 shrink-0 transition-colors motion-safe:duration-200", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
      <span className="truncate">{item.label}</span>
      {isActive && (
        <span aria-hidden className="pointer-events-none absolute inset-y-1.5 start-0 w-1 rounded-full bg-primary" />
      )}
    </button>
  );
}

function SideNav({
  active,
  onNavigate,
  onSignOut,
  userName,
  userRole,
  forceUserMode = false,
  features,
}: {
  active: string;
  onNavigate: (view: string) => void;
  onSignOut: () => void;
  userName: string;
  userRole?: string;
  forceUserMode?: boolean;
  features: PlanFeatures | null;
}) {
  const isAdmin = userRole === "admin";
  const showAdminGroup = isAdmin && !forceUserMode;

  // Persist expand state per user (Item 5). Default: account + the active
  // group expanded, others collapsed. The hook is in the parent so the
  // state survives re-renders of NavLink (which happens on every nav click).
  const [openGroups, setOpenGroups] = useState<Record<NavGroupId, boolean>>(() => {
    if (typeof window === "undefined") return { account: true } as Record<NavGroupId, boolean>;
    try {
      const raw = window.localStorage.getItem(NAV_GROUPS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Record<NavGroupId, boolean>>;
        const base: Record<NavGroupId, boolean> = {
          account: true, content: false, ai: false, bots: false, gold: false, admin: false,
        };
        return { ...base, ...parsed } as Record<NavGroupId, boolean>;
      }
    } catch {
      /* storage may be unavailable — fall through to defaults */
    }
    return { account: true } as Record<NavGroupId, boolean>;
  });

  // Find which group the active item belongs to. If that group is closed,
  // open it (so the active item is always reachable). Item 21-3: enforce
  // accordion (single-open) semantics — when the active group's parent is
  // auto-opened on navigation, all other groups are closed too so only one
  // group is ever open at a time. localStorage is updated so the user's
  // last-open group survives across sessions.
  //
  // NOTE: deps are intentionally `[active]` only (NOT `openGroups`) so the
  // effect fires on NAVIGATION, not on every toggle. Otherwise toggling
  // the active group closed would immediately re-open it (because closing
  // the active group's parent would trip the effect → auto-reopen). With
  // deps=`[active]`, the user can deliberately close the active group via
  // the trigger and it stays closed until they navigate again.
  useEffect(() => {
    const activeItem = NAV.find((n) => n.view === active);
    if (!activeItem) return;
    setOpenGroups((cur) => {
      if (cur[activeItem.group]) return cur; // already open — preserve state, no-op
      const next: Record<NavGroupId, boolean> = {
        account: false, content: false, ai: false, bots: false, gold: false, admin: false,
      };
      next[activeItem.group] = true;
      try {
        window.localStorage.setItem(NAV_GROUPS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore storage errors */
      }
      return next;
    });
  }, [active]);

  // Item 21-3: accordion behavior — opening a group CLOSES all other
  // groups; closing a group just closes it (the others stay as they
  // were). Combined with the useEffect above, this guarantees that
  // clicking an item in another group auto-closes the previously-open
  // group so the user never has to manage two open panes at once.
  function toggle(id: NavGroupId) {
    setOpenGroups((cur) => {
      const willOpen = !cur[id];
      const next: Record<NavGroupId, boolean> = willOpen
        ? { account: false, content: false, ai: false, bots: false, gold: false, admin: false }
        : { ...cur };
      next[id] = willOpen;
      try {
        window.localStorage.setItem(NAV_GROUPS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore storage errors */
      }
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col" dir="rtl">
      <nav className="scrollbar-thin flex flex-1 flex-col gap-1.5 overflow-y-auto px-2 py-3">
        {NAV_GROUPS.filter((g) => !g.adminOnly || showAdminGroup).map((g) => {
          const items = NAV.filter((n) => n.group === g.id && isVisible(n, isAdmin, features));
          return (
            <NavGroup
              key={g.id}
              group={g}
              items={items}
              active={active}
              onNavigate={onNavigate}
              open={openGroups[g.id] ?? false}
              onToggle={toggle}
            />
          );
        })}
      </nav>

      {/* User card + ad slot at the very bottom of the sidebar */}
      <div className="mt-2 flex flex-col gap-3 border-t border-border/60 bg-gradient-to-b from-muted/30 to-transparent p-2 pt-3">
        <AdSlot placement="user_dashboard_sidebar" />
        <div className="relative overflow-hidden rounded-lg border border-border/60 bg-card/80 p-3 text-xs shadow-sm shadow-primary/5">
          <div className="pointer-events-none absolute -top-6 -start-6 size-16 rounded-full bg-primary/10 blur-xl" aria-hidden />
          <div className="relative flex items-center gap-2.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/70 text-sm font-bold text-primary-foreground shadow-sm shadow-primary/30">
              {(userName || "؟").trim().charAt(0) || "؟"}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] text-muted-foreground">کاربر</div>
              <div className="mt-0.5 truncate font-semibold text-foreground">{userName}</div>
              {userRole && (
                <div className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span aria-hidden className="size-1 rounded-full bg-accent" />
                  نقش: {roleFa(userRole)}
                </div>
              )}
            </div>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onSignOut}
          className="group justify-start gap-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <LogOutIcon className="size-4 motion-safe:transition-transform group-hover:-translate-x-0.5" />
          خروج
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Redesigned home view (Item 7)
// ---------------------------------------------------------------------
type HomeStats = {
  totalContents: number;
  totalDestinations: number;
  totalPublishes: number;
  totalViews: number;
};

type HomeUsage = {
  hasActivePlan: boolean;
  planName: string | null;
  planCode: string | null;
  remainingDays: number | null;
  endsAt: string | null;
};

type HomeNotification = {
  id: string;
  titleFa: string;
  createdAt: string;
  read: boolean;
};

type HomePublish = {
  id: string;
  title: string;
  deliveredAt: string | null;
  status: string;
};

function HomeKpiCard({
  Icon,
  tint,
  label,
  value,
}: {
  Icon: LucideIcon;
  tint: string;
  label: string;
  value: string;
}) {
  return (
    <Card className="group relative overflow-hidden gap-1 border-border/60 p-3 shadow-sm shadow-primary/5 transition-all motion-safe:duration-200 hover:-translate-y-0.5 hover:shadow-md hover:shadow-primary/10 hover:border-primary/20">
      <div className="pointer-events-none absolute -top-8 -end-8 size-20 rounded-full bg-primary/5 opacity-0 blur-2xl transition-opacity motion-safe:duration-300 group-hover:opacity-100" aria-hidden />
      <div className="relative flex items-center gap-2">
        <div className={cn("flex size-7 items-center justify-center rounded-md shadow-sm", tint)}>
          <Icon className="size-4" />
        </div>
        <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      </div>
      <div className="relative text-xl font-bold tabular-nums text-foreground">{value}</div>
    </Card>
  );
}

function HomeQuickAction({
  Icon,
  label,
  hint,
  onClick,
}: {
  Icon: LucideIcon;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex flex-col items-start gap-2 overflow-hidden rounded-xl border border-border/60 bg-card p-3 text-right shadow-sm shadow-primary/5 transition-all motion-safe:duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:bg-gradient-to-b hover:from-primary/5 hover:to-transparent hover:shadow-md hover:shadow-primary/10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="pointer-events-none absolute -top-6 -end-6 size-14 rounded-full bg-primary/10 opacity-0 blur-xl transition-opacity motion-safe:duration-300 group-hover:opacity-100" aria-hidden />
      <div className="relative flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-primary/15 to-primary/5 text-primary shadow-sm shadow-primary/10 transition-colors motion-safe:duration-200 group-hover:from-primary/20 group-hover:to-primary/10">
        <Icon className="size-5" />
      </div>
      <div className="relative">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-[11px] text-muted-foreground">{hint}</div>
      </div>
    </button>
  );
}

function HomeView({
  navigate,
  firstName,
}: {
  navigate: (to: string) => void;
  firstName: string;
}) {
  const [stats, setStats] = useState<HomeStats | null>(null);
  const [usage, setUsage] = useState<HomeUsage | null>(null);
  const [notifications, setNotifications] = useState<HomeNotification[]>([]);
  const [recentPublishes, setRecentPublishes] = useState<HomePublish[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [statsRes, usageRes, notifRes] = await Promise.all([
          fetch("/api/stats/me", { credentials: "same-origin" }),
          fetch("/api/me/usage", { credentials: "same-origin" }),
          fetch("/api/notifications?limit=3&offset=0", { credentials: "same-origin" }),
        ]);
        const statsJson = statsRes.ok ? await statsRes.json() : null;
        const usageJson = usageRes.ok ? await usageRes.json() : null;
        const notifJson = notifRes.ok ? await notifRes.json() : null;
        if (cancelled) return;
        if (statsJson?.summary) {
          setStats({
            totalContents: statsJson.summary.totalContents ?? 0,
            totalDestinations: statsJson.summary.totalDestinations ?? 0,
            totalPublishes: statsJson.summary.totalPublishes ?? 0,
            totalViews: statsJson.summary.totalViews ?? 0,
          });
        }
        if (usageJson) {
          setUsage({
            hasActivePlan: Boolean(usageJson.hasActivePlan),
            planName: usageJson.planName ?? null,
            planCode: usageJson.planCode ?? null,
            remainingDays: usageJson.remainingDays ?? null,
            endsAt: usageJson.endsAt ?? null,
          });
        }
        if (notifJson?.items) {
          setNotifications(notifJson.items as HomeNotification[]);
        }
      } catch {
        /* swallow — the home view degrades gracefully */
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const hasPlan = usage?.hasActivePlan && (usage.remainingDays ?? 0) > 0;

  return (
    <div className="flex flex-col gap-5" dir="rtl">
      {/* Welcome header */}
      <div className="relative overflow-hidden rounded-2xl border border-primary/10 bg-gradient-to-l from-primary/10 via-card to-card p-5 shadow-sm shadow-primary/5 sm:p-6">
        <div className="pointer-events-none absolute -top-12 -end-10 size-40 rounded-full bg-primary/10 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-16 -start-10 size-32 rounded-full bg-accent/15 blur-3xl" aria-hidden />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="mb-1 inline-flex items-center gap-1.5 rounded-full border border-primary/15 bg-primary/5 px-2 py-0.5 text-[10px] font-medium text-primary">
              <SparklesIcon className="size-3" />
              داشبورد پُست‌یار
            </div>
            <h1 className="text-xl font-bold sm:text-2xl">
              خوش آمدی، {firstName || "کاربر پُست‌یار"}
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {hasPlan
                ? `پلن فعال: ${usage?.planName ?? "—"}`
                : "بدون پلن فعال — برای دسترسی به همهٔ قابلیت‌ها یک پلن انتخاب کنید."}
            </p>
          </div>
          {hasPlan ? (
            <Badge variant="secondary" className="gap-1.5 border-primary/15 bg-primary/10 px-3 py-1.5 text-xs text-primary">
              <PackageIcon className="size-3.5" />
              {toPersianDigits(usage?.remainingDays ?? 0)} روز باقی‌مانده
            </Badge>
          ) : (
            <Button
              variant="default"
              size="sm"
              onClick={() => navigate("/dashboard/plans")}
              className="gap-1.5 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <SparklesIcon className="size-4" />
              ارتقای پلن
            </Button>
          )}
        </div>
      </div>

      {/* Inline KPI strip */}
      <section>
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
              <BarChart3Icon className="size-3.5" />
            </span>
            نمای کلی
          </h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/dashboard/stats")}
            className="gap-1.5 cursor-pointer text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            مشاهدهٔ آمار کامل
          </Button>
        </div>
        {loading ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <HomeKpiCard Icon={FileTextIcon} tint="bg-primary/15 text-primary" label="محتوا" value={toPersianDigits(stats?.totalContents ?? 0)} />
            <HomeKpiCard Icon={LayoutGridIcon} tint="bg-accent/25 text-accent-foreground" label="کانال‌ها / مقاصد" value={toPersianDigits(stats?.totalDestinations ?? 0)} />
            <HomeKpiCard Icon={SendIcon} tint="bg-primary/20 text-primary" label="انتشار" value={toPersianDigits(stats?.totalPublishes ?? 0)} />
            <HomeKpiCard Icon={ActivityIcon} tint="bg-accent/30 text-accent-foreground" label="بازدید" value={toPersianDigits(stats?.totalViews ?? 0)} />
          </div>
        )}
      </section>

      {/* Quick actions */}
      <section>
        <h2 className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-foreground">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
            <ZapIcon className="size-3.5" />
          </span>
          دسترسی سریع
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <HomeQuickAction Icon={PlusIcon} label="ساخت محتوا" hint="ویرایشگر محتوا" onClick={() => navigate("/dashboard/content-editor")} />
          <HomeQuickAction Icon={SendIcon} label="افزودن مقصد" hint="کانال‌های انتشار" onClick={() => navigate("/dashboard/destinations")} />
          <HomeQuickAction Icon={BotIcon} label="ساخت بات" hint="بات‌ساز تلگرام/بله" onClick={() => navigate("/dashboard/bots")} />
          <HomeQuickAction Icon={WalletIcon} label="شارژ کیف پول" hint="افزایش موجودی" onClick={() => navigate("/dashboard/wallet")} />
          <HomeQuickAction Icon={TicketIcon} label="تیکت پشتیبانی" hint="پشتیبانی پُست‌یار" onClick={() => navigate("/dashboard/tickets")} />
          <HomeQuickAction Icon={GraduationCapIcon} label="آموزش" hint="راهنمای گام‌به‌گام" onClick={() => navigate("/dashboard/training")} />
        </div>
      </section>

      {/* Recent activity */}
      <section>
        <h2 className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-foreground">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
            <BellIcon className="size-3.5" />
          </span>
          آخرین اعلان‌ها
        </h2>
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : notifications.length === 0 ? (
          <Card className="flex flex-col items-center justify-center gap-2 border-dashed border-border/60 p-6 text-center text-xs text-muted-foreground">
            <span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <BellIcon className="size-4" />
            </span>
            اعلان جدیدی برای نمایش وجود ندارد.
          </Card>
        ) : (
          <Card className="overflow-hidden border-border/60 shadow-sm shadow-primary/5">
            <div className="divide-y divide-border/60">
              {notifications.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => navigate("/dashboard/notifications")}
                  className="flex w-full items-start gap-3 p-3 text-right transition-colors hover:bg-primary/5 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className={cn("mt-1 size-2 shrink-0 rounded-full transition-colors", n.read ? "bg-muted-foreground/30" : "bg-primary shadow-[0_0_0_3px] shadow-primary/15")} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{n.titleFa || "اعلان"}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {n.createdAt ? formatJalaliDate(n.createdAt) : "—"}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </Card>
        )}
      </section>
    </div>
  );
}

function NotImplemented({ name }: { name: string }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 text-center" dir="rtl">
      <BotIcon className="size-8 text-muted-foreground" />
      <div className="text-sm font-medium">بخش «{name}» هنوز پیاده‌سازی نشده است.</div>
      <div className="max-w-md text-xs text-muted-foreground">
        این بخش توسط یکی از عامل‌های دیگر توسعه داده می‌شود.
      </div>
    </div>
  );
}

/** Upgrade card shown when a non-admin user lands on a gated view (Item 9). */
function UpgradeRequired({ navigate }: { navigate: (to: string) => void }) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center" dir="rtl">
      <div className="flex size-14 items-center justify-center rounded-full bg-amber-100 text-amber-700">
        <SparklesIcon className="size-7" />
      </div>
      <div className="text-base font-semibold">ارتقای پلن لازم است</div>
      <div className="max-w-md text-xs text-muted-foreground">
        این بخش جزئی از پلن فعلی شما نیست. برای دسترسی به این قابلیت، لطفاً پلن خود را ارتقا دهید.
      </div>
      <Button
        variant="default"
        size="sm"
        onClick={() => navigate("/dashboard/plans")}
        className="gap-1.5 cursor-pointer"
      >
        <SparklesIcon className="size-4" />
        ارتقای پلن
      </Button>
    </div>
  );
}

// Bottom mobile navbar — quick-access for the 5 key destinations. Visible
// ONLY on < lg screens (lg:hidden) so it never collides with the desktop
// sidebar. The center "انتشار" button is elevated (-mt-6) to act as a FAB.
function BottomNav({
  active,
  onNavigate,
}: {
  active: string;
  onNavigate: (view: string) => void;
}) {
  const items: {
    view: string;
    label: string;
    Icon: React.ComponentType<{ className?: string }>;
    elevated?: boolean;
  }[] = [
    { view: "home", label: "خانه", Icon: LayoutGridIcon },
    { view: "destinations", label: "کانال‌ها", Icon: SendIcon },
    { view: "content-editor", label: "انتشار", Icon: PlusIcon, elevated: true },
    { view: "notifications", label: "اعلان‌ها", Icon: BellIcon },
    { view: "profile", label: "پروفایل", Icon: UserIcon },
  ];
  return (
    <nav
      dir="rtl"
      aria-label="ناوبری پایین صفحه"
      className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-between gap-1 border-t border-border/60 bg-background/85 px-2 backdrop-blur-md shadow-[0_-4px_24px_-12px_rgba(0,0,0,0.12)] lg:hidden supports-[backdrop-filter]:bg-background/70"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-l from-transparent via-primary/30 to-transparent" />
      {items.map((it) => {
        const Icon = it.Icon;
        const isActive = active === it.view;
        if (it.elevated) {
          return (
            <button
              key={it.view}
              type="button"
              onClick={() => onNavigate(it.view)}
              aria-label={it.label}
              aria-current={isActive ? "page" : undefined}
              className="group flex flex-1 flex-col items-center justify-end gap-0.5 pb-1 pt-2 text-[11px] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="relative -mt-6 flex size-12 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-lg shadow-primary/30 ring-4 ring-background transition-transform motion-safe:duration-200 motion-safe:hover:scale-105 motion-safe:active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span aria-hidden className="pointer-events-none absolute inset-0 rounded-full bg-primary/40 opacity-50 blur-md" />
                <Icon className="relative size-6" />
              </span>
              <span className={isActive ? "font-medium text-primary" : "text-muted-foreground"}>
                {it.label}
              </span>
            </button>
          );
        }
        return (
          <button
            key={it.view}
            type="button"
            onClick={() => onNavigate(it.view)}
            aria-label={it.label}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "group relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] transition-colors motion-safe:duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-95",
              isActive ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {isActive && (
              <span aria-hidden className="absolute top-0 h-0.5 w-8 rounded-full bg-primary" />
            )}
            <Icon className={cn("size-5 transition-transform motion-safe:duration-200", isActive ? "scale-110" : "group-hover:scale-105")} />
            <span className={isActive ? "font-medium" : ""}>{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------
// Dashboard root
// ---------------------------------------------------------------------
export function Dashboard({ navigate, initialView, param }: DashboardProps) {
  const { user, signOut } = useSession();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Admin ↔ User mode toggle. Lets an admin "use the app as a regular user"
  // (user-mode hides admin-only nav + admin views render as inaccessible
  // surfaces). Defaults to "admin" so admins always start in the admin panel;
  // non-admins never see the toggle at all.
  const [mode, setMode] = useState<"admin" | "user">("admin");

  // Subscription gating (Item 9): fetch /api/me/usage once and keep the
  // parsed planFeatures around. Until loaded, treat as "all features
  // granted" so admins + new sessions see the full nav (better UX than
  // hiding everything until the fetch resolves).
  const [features, setFeatures] = useState<PlanFeatures | null>(null);
  const [featuresLoaded, setFeaturesLoaded] = useState(false);

  // Strip any ?query from initialView/param (in case the editor is opened
  // with ?action=publish — the editor itself surfaces the publish actions).
  const cleanView = useMemo(() => initialView.split("?")[0] ?? initialView, [initialView]);
  const cleanParam = useMemo(() => (param ? param.split("?")[0] : undefined), [param]);

  // Scroll-to-top on nav change (Item 6). Both the scrollable main wrapper
  // (when present on mobile/desktop with overflow) AND the window are reset
  // so the new view always starts at its top.
  const mainScrollRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (mainScrollRef.current) {
      mainScrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
    // Fallback: scroll the window itself (some layouts have no inner scroll).
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [cleanView, cleanParam]);

  // Fetch the user's plan features once. We deliberately swallow errors —
  // on failure, the dashboard falls back to "all account essentials only"
  // (since features stay null → gated items are hidden for non-admins).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/me/usage", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setFeatures((d.planFeatures as PlanFeatures) ?? {});
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setFeaturesLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  function onSignOut() {
    void signOut();
    navigate("/");
  }
  function onNavigate(view: string) {
    navigate(`/dashboard/${view}`);
    setSidebarOpen(false);
  }

  const isAdmin = user?.role === "admin";
  // Admins in admin mode (or while features are loading) bypass gating.
  // While features are still loading for a non-admin, we render the
  // "essentials only" nav (since features === null ⇒ all gated items
  // hidden), but the renderView path still allows the current view to
  // render so the user isn't blocked while the fetch resolves.
  const gatingActive = featuresLoaded && !isAdmin;
  const viewGranted = !gatingActive || isViewGranted(cleanView, isAdmin, features);

  function renderView(): ReactNode {
    // Subscription gate: if the user landed on a gated view (via URL),
    // show the upgrade card instead of the view.
    if (gatingActive && !viewGranted) {
      return <UpgradeRequired navigate={navigate} />;
    }
    switch (cleanView) {
      case "home":
        return <HomeView navigate={navigate} firstName={user?.firstName ?? ""} />;
      case "stats":
        return <StatsView navigate={navigate} />;
      case "content":
        return <ContentManagerView navigate={navigate} />;
      case "content-editor":
        return <ContentEditorView contentId={cleanParam} navigate={navigate} />;
      case "destinations":
        return <DestinationsView navigate={navigate} />;
      case "glass-buttons":
        // destinationId is optional — when absent, the view shows the
        // preset library (destination-less glass buttons).
        return <GlassButtonsView destinationId={cleanParam || undefined} navigate={navigate} />;
      case "plans":
        return <PlansView navigate={navigate} />;
      case "payment":
        if (!cleanParam) return <NoPlanCheckout navigate={navigate} />;
        return <PaymentView planId={cleanParam} navigate={navigate} />;
      case "orders":
        return <OrdersView navigate={navigate} />;
      case "wallet":
        return <WalletView navigate={navigate} />;
      case "ledger":
        return <LedgerView navigate={navigate} />;
      case "referral":
        return <ReferralView navigate={navigate} />;
      case "subscriptions":
        return <SubscriptionsView navigate={navigate} />;
      case "profile":
        return <ProfileView navigate={navigate} />;
      case "training":
        return <Training navigate={navigate} />;
      // ===== Task 10-C views =====
      case "ai-caption":
        return <AiCaptionView navigate={navigate} />;
      case "ai-text":
        return <AiTextView />;
      case "smart-reply":
        return <SmartReplyView />;
      case "auto-responder":
        return <AutoResponderView />;
      case "inbox":
        return <InboxView />;
      case "gold":
        return <GoldView />;
      case "gold-bot":
        return <GoldBotView />;
      case "woo":
        return <WooView navigate={navigate} />;
      case "tickets":
        return <TicketsView navigate={navigate} />;
      case "ticket":
        if (!cleanParam) return <NotImplemented name="تیکت (بدون شناسه)" />;
        return <TicketDetailView ticketId={cleanParam} navigate={navigate} />;
      case "notifications":
        return <NotificationsView navigate={navigate} />;
      case "advertising":
        return <AdvertisingView navigate={navigate} />;
      // ===== Task 10-D — Bot Builder views =====
      case "bots":
        return <BotsListView navigate={navigate} />;
      case "bot-workflow":
        // botId is optional — when absent, the view shows all the user's
        // workflows across bots + a bot-less templates section.
        return <BotWorkflowView botId={cleanParam || undefined} navigate={navigate} />;
      case "bot-link":
        // botId is optional — when absent, the view shows all the user's
        // link codes across bots + a personal-codes section.
        return <BotLinkView botId={cleanParam || undefined} navigate={navigate} />;
      case "bot-history":
        // botId is optional — when absent, the view shows the unified
        // history across all the user's bots (filterable).
        return <BotHistoryView botId={cleanParam || undefined} navigate={navigate} />;
      case "bot-broadcast":
        // botId is optional — when absent, the view broadcasts to
        // destinations (channels) directly instead of bot users.
        return <BotBroadcastView botId={cleanParam || undefined} navigate={navigate} />;
      // ===== Task 10-D — Admin Panel views =====
      case "admin-stats":
        return <AdminStatsView navigate={navigate} />;
      case "admin-users":
        return <AdminUsersView navigate={navigate} />;
      case "admin-plans":
        return <AdminPlansView navigate={navigate} />;
      case "admin-audit":
        return <AdminAuditView navigate={navigate} />;
      case "admin-health":
        return <AdminHealthView navigate={navigate} />;
      case "admin-ads":
        return <AdminAdsView navigate={navigate} />;
      case "admin-discounts":
        return <AdminDiscountsView navigate={navigate} />;
      case "admin-bank-cards":
        return <AdminBankCardsView navigate={navigate} />;
      case "admin-orders":
        return <AdminOrdersView navigate={navigate} />;
      case "admin-orders-review":
        return <AdminOrdersReviewView navigate={navigate} />;
      case "admin-subscriptions":
        return <AdminSubscriptionsView navigate={navigate} />;
      case "admin-bots":
        return <AdminBotsView navigate={navigate} />;
      case "admin-woo":
        return <AdminWooView navigate={navigate} />;
      case "admin-gold":
        return <AdminGoldView navigate={navigate} />;
      case "admin-broadcast":
        return <AdminBroadcastView navigate={navigate} />;
      case "admin-tickets":
        return <AdminTicketsView navigate={navigate} />;
      case "admin-settings":
        return <AdminSettingsView navigate={navigate} />;
      default:
        return <NotImplemented name={cleanView} />;
    }
  }

  const userName = user ? `${user.firstName} ${user.lastName}` : "کاربر پُست‌یار";

  return (
    <div className="relative flex min-h-screen flex-col bg-gradient-to-b from-muted/40 via-background to-background" dir="rtl">
      {/* Decorative ambient gradient on the root wrapper — very subtle so
          content readability is never affected. Stays within the teal-green
          + warm-gold palette (no indigo/blue). */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(50rem_25rem_at_85%_-5%,oklch(0.45_0.13_170/0.05),transparent),radial-gradient(40rem_20rem_at_-5%_5%,oklch(0.78_0.13_80/0.06),transparent)]" />
      {/* Sticky ad bar (top) — fixed across the dashboard. Other agents
          built this; we just mount it once at the root. */}
      <StickyAdBar placement="sticky_bar" position="top" />

      {/* Top bar — premium "stage" with thin teal→gold accent strip on top
          and a translucent glass background. */}
      <header className="sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-border/60 bg-background/80 px-4 backdrop-blur-md supports-[backdrop-filter]:bg-background/65 sm:px-5">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-l from-primary via-primary/70 to-accent" />
        <div className="relative flex h-full flex-1 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors hover:bg-muted/60"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label="نمایش نوار کناری"
          >
            {sidebarOpen ? <XIcon className="size-5" /> : <MenuIcon className="size-5" />}
          </Button>
          <Logo size={28} />
          <HeaderClock className="hidden sm:block" />
          <div className="flex-1" />
          {/* Admin ↔ User mode toggle — admins only. Lets an admin switch back
              and forth between the admin panel and the regular-user surface. */}
          {user?.role === "admin" && (
            <Button
              variant={mode === "admin" ? "outline" : "default"}
              size="sm"
              onClick={() => setMode((m) => (m === "admin" ? "user" : "admin"))}
              aria-pressed={mode === "user"}
              className="gap-1.5 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors"
            >
              {mode === "admin" ? (
                <>
                  <LayoutGridIcon className="size-4" />
                  <span className="hidden sm:inline">دیدن به‌عنوان کاربر</span>
                  <span className="sm:hidden">کاربر</span>
                </>
              ) : (
                <>
                  <ShieldCheckIcon className="size-4" />
                  <span className="hidden sm:inline">بازگشت به پنل مدیریت</span>
                  <span className="sm:hidden">مدیر</span>
                </>
              )}
            </Button>
          )}
          <NotificationBell />
          <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
            <span className="flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-primary/15 to-accent/15 text-xs font-bold text-primary">
              {(userName || "؟").trim().charAt(0) || "؟"}
            </span>
            <span>
              کاربر: {userName} • نقش: {roleFa(user?.role)}
            </span>
          </div>
        </div>
      </header>

      <div className="flex flex-1 lg:gap-0">
        {/* Sidebar — on mobile a drawer (fixed + translate), on desktop (lg+)
            it is FIXED below the header so the menu never moves when the
            main content is scrolled. The main content gets a right padding
            on desktop (lg:pr-64) to clear the fixed sidebar. */}
        <aside
          className={cn(
            "fixed lg:fixed inset-y-0 right-0 z-30 w-64 border-l border-border/60 bg-card/70 backdrop-blur-md transition-transform lg:translate-x-0 lg:border-l-0 lg:bg-transparent lg:backdrop-blur-none supports-[backdrop-filter]:bg-card/50",
            "lg:top-16 lg:bottom-0 lg:overflow-y-auto",
            sidebarOpen ? "translate-x-0" : "translate-x-full lg:translate-x-0",
          )}
          style={{ top: "4rem" }}
        >
          <div className="flex h-full flex-col">
            <SideNav
              active={cleanView}
              onNavigate={onNavigate}
              onSignOut={onSignOut}
              userName={userName}
              userRole={user?.role}
              forceUserMode={user?.role === "admin" && mode === "user"}
              features={features}
            />
          </div>
        </aside>
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-20 bg-black/50 backdrop-blur-sm lg:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* Main — extra bottom padding on mobile so the fixed bottom navbar
            never covers content (lg:pb-6 restores the original desktop spacing).
            lg:pr-64 clears the fixed 16rem (w-64) desktop sidebar on the right. */}
        <main
          ref={mainScrollRef}
          className="flex-1 p-4 pb-24 lg:p-6 lg:pr-64 lg:pb-6"
          dir="rtl"
        >
          <div className="mx-auto flex max-w-6xl flex-col gap-6">
            {/* Ad slot at the very top of the dashboard main content area.
                Empty state renders nothing — non-intrusive. */}
            <AdSlot placement="user_dashboard_top" />
            {renderView()}
          </div>
        </main>
      </div>

      {/* Bottom mobile navbar — quick access to the 5 key destinations.
          Visible ONLY on < lg so it never collides with the desktop sidebar. */}
      <BottomNav active={cleanView} onNavigate={onNavigate} />

      <footer
        dir="rtl"
        className="relative mt-auto border-t border-border/60 bg-background/80 py-4"
      >
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-l from-transparent via-primary/30 to-transparent" />
        <div className="mx-auto flex max-w-6xl items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground">
          <span aria-hidden className="size-1.5 rounded-full bg-primary" />
          <span>پُست‌یار © {toPersianDigits(new Date().getFullYear() - 621)}</span>
          <span className="text-muted-foreground/50">—</span>
          <span>نسخهٔ پیش‌نمایش</span>
        </div>
      </footer>
    </div>
  );
}

export default Dashboard;
