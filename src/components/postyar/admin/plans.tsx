"use client";
// =====================================================================
// POSTYAR — Admin Plans View (revamp2-plans, items 31–34)
// ---------------------------------------------------------------------
// Granular plan management:
//   • ITEM 31 — Feature catalog with checkboxes (boolean) + number
//     inputs (quota) grouped into 6 collapsible Accordion sections.
//     Persisted to Plan.features JSON; Plan.quota JSON retained for
//     backward-compat with the legacy quota engine.
//   • ITEM 32 — Discount percentage (0–100) with live price preview
//     «قیمت با تخفیف: X ریال» = priceRials × (1 − discountPct/100).
//   • ITEM 33 — Plan image: text URL input + upload-via-/api/media-upload
//     button. Thumbnail preview when set; placeholder with the plan's
//     first letter otherwise.
//   • ITEM 34 — Early-renewal discount: renewalDiscountPct (0–100) +
//     renewalDiscountWindowDays (0–365). Persian note explaining the
//     semantics.
//
// List view: thumbnail, name, price (Persian digits + «ریال», strikethrough
// when discount applies), interval, discount badge, renewal badge, active
// toggle (inline Switch), feature-count badge (e.g. «۱۶ امکان»),
// sort-order input. Rows sorted by sortOrder asc then priceRials asc.
//
// Persian + RTL everywhere. lucide-react icons only. cursor-pointer +
// focus-visible:ring-2 on every custom click target. Toasts via sonner.
// Loading skeleton + error + empty states.
// =====================================================================
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertCircleIcon,
  Loader2Icon,
  PackageIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  TagIcon,
  Trash2Icon,
  UploadCloudIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  api,
  type AdminPlanRow,
  type AdminPlanInput,
  type AdminPlanPatch,
  type PlanFeatures,
  type PlanFeatureKey,
} from "@/components/postyar/api";
import { AdminGate } from "@/components/postyar/admin/gate";
import { formatRials, toPersianDigits } from "@/lib/persian";
// CLIENT BOUNDARY: import the feature catalog from the pure, Prisma-free
// module — importing it from `@/lib/payments/plans` used to pull the whole
// Prisma client into the browser bundle and crash at runtime.
import {
  FEATURE_CATALOG,
  ALL_FEATURE_DEFS,
  countEnabledFeatures,
  isBooleanFeature,
  type PlanFeatureDef,
} from "@/lib/payments/plan-catalog";

// =====================================================================
// Form state — features are kept as a `PlanFeatures` object (not JSON
// text) so the UI never round-trips through a JSON editor.
// =====================================================================
interface PlanFormState {
  id?: string;
  code: string;
  nameFa: string;
  descriptionFa: string;
  priceRials: string;
  intervalMonths: string;
  quotaJson: string;
  features: PlanFeatures;
  imageUrl: string;
  discountPct: string;
  renewalDiscountPct: string;
  renewalDiscountWindowDays: string;
  sortOrder: string;
  active: boolean;
  isPublic: boolean;
}

function emptyFeatures(): PlanFeatures {
  const out: PlanFeatures = {};
  for (const def of ALL_FEATURE_DEFS) {
    if (def.type === "boolean") out[def.key] = false;
    else out[def.key] = 0;
  }
  return out;
}

function emptyForm(): PlanFormState {
  return {
    code: "",
    nameFa: "",
    descriptionFa: "",
    priceRials: "0",
    intervalMonths: "1",
    quotaJson: "{}",
    features: emptyFeatures(),
    imageUrl: "",
    discountPct: "0",
    renewalDiscountPct: "0",
    renewalDiscountWindowDays: "0",
    sortOrder: "0",
    active: true,
    isPublic: true,
  };
}

function fromRow(r: AdminPlanRow): PlanFormState {
  // Seed every known key so the UI shows the full catalog even when the
  // stored JSON omits some (older plans created before revamp2).
  const features = emptyFeatures();
  for (const def of ALL_FEATURE_DEFS) {
    const v = r.features?.[def.key];
    if (def.type === "boolean") {
      features[def.key] = typeof v === "boolean" ? v : false;
    } else {
      features[def.key] =
        typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
    }
  }
  return {
    id: r.id,
    code: r.code,
    nameFa: r.nameFa,
    descriptionFa: r.descriptionFa,
    priceRials: String(r.priceRials),
    intervalMonths: String(r.intervalMonths),
    quotaJson: JSON.stringify(r.quota ?? {}, null, 2),
    features,
    imageUrl: r.imageUrl ?? "",
    discountPct: String(r.discountPct ?? 0),
    renewalDiscountPct: String(r.renewalDiscountPct ?? 0),
    renewalDiscountWindowDays: String(r.renewalDiscountWindowDays ?? 0),
    sortOrder: String(r.sortOrder ?? 0),
    active: r.active,
    isPublic: r.isPublic,
  };
}

export interface AdminPlansViewProps {
  navigate: (to: string) => void;
}

function AdminPlansInner({ navigate: _navigate }: AdminPlansViewProps) {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<PlanFormState>(emptyForm);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["admin", "plans"],
    queryFn: () => api.getAdminPlansTyped(),
    staleTime: 30_000,
  });

  // ----- Inline (list-row) mutations ---------------------------------
  const toggleActiveMut = useMutation({
    mutationFn: async (input: { id: string; active: boolean }) =>
      api.adminUpdatePlan(input.id, { active: input.active }),
    onSuccess: () => {
      toast.success("وضعیت طرح به‌روز شد.");
      qc.invalidateQueries({ queryKey: ["admin", "plans"] });
      qc.invalidateQueries({ queryKey: ["public", "plans"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "به‌روزرسانی ناموفق بود."),
  });

  const setSortOrderMut = useMutation({
    mutationFn: async (input: { id: string; sortOrder: number }) =>
      api.adminUpdatePlan(input.id, { sortOrder: input.sortOrder }),
    onSuccess: () => {
      // Don't toast on every keystroke; just refetch silently.
      qc.invalidateQueries({ queryKey: ["admin", "plans"] });
      qc.invalidateQueries({ queryKey: ["public", "plans"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "به‌روزرسانی ناموفق بود."),
  });

  function openCreate() {
    setForm(emptyForm());
    setShowForm(true);
  }
  function openEdit(r: AdminPlanRow) {
    setForm(fromRow(r));
    setShowForm(true);
  }

  // ----- Create / update (form) --------------------------------------
  const saveMut = useMutation({
    mutationFn: async () => {
      const priceRials = Number(form.priceRials.replace(/[,٬]/g, ""));
      const intervalMonths = Number(form.intervalMonths);
      if (!Number.isFinite(priceRials) || priceRials < 0) throw new Error("مبلغ نامعتبر است.");
      if (!Number.isFinite(intervalMonths) || intervalMonths < 1 || intervalMonths > 12)
        throw new Error("بازهٔ ماه نامعتبر است.");
      const discountPct = Number(form.discountPct);
      if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100)
        throw new Error("درصد تخفیف باید بین ۰ تا ۱۰۰ باشد.");
      const renewalDiscountPct = Number(form.renewalDiscountPct);
      if (!Number.isFinite(renewalDiscountPct) || renewalDiscountPct < 0 || renewalDiscountPct > 100)
        throw new Error("درصد تخفیف تمدید باید بین ۰ تا ۱۰۰ باشد.");
      const renewalDiscountWindowDays = Number(form.renewalDiscountWindowDays);
      if (
        !Number.isFinite(renewalDiscountWindowDays) ||
        renewalDiscountWindowDays < 0 ||
        renewalDiscountWindowDays > 365
      )
        throw new Error("پنجرهٔ تمدید باید بین ۰ تا ۳۶۵ روز باشد.");
      const sortOrder = Number(form.sortOrder);
      if (!Number.isFinite(sortOrder) || sortOrder < 0)
        throw new Error("ترتیب نمایش نامعتبر است.");
      // Validate quota JSON (still kept for backward-compat).
      const quota = (() => {
        try {
          return JSON.parse(form.quotaJson || "{}");
        } catch {
          throw new Error("JSON سهمیه نامعتبر است.");
        }
      })();

      // Build the clean features payload: only include keys that differ
      // from their default (false / 0) plus any explicit true / >0 values.
      // This keeps the stored JSON tidy.
      const features: PlanFeatures = {};
      for (const def of ALL_FEATURE_DEFS) {
        const v = form.features[def.key];
        if (def.type === "boolean") {
          if (v === true) features[def.key] = true;
        } else {
          const n = typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
          if (n > 0) features[def.key] = n;
        }
      }

      const imageUrl = form.imageUrl.trim();

      if (form.id) {
        const patch: AdminPlanPatch = {
          nameFa: form.nameFa.trim(),
          descriptionFa: form.descriptionFa,
          priceRials,
          intervalMonths,
          quota,
          features,
          imageUrl: imageUrl.length > 0 ? imageUrl : null,
          discountPct,
          renewalDiscountPct,
          renewalDiscountWindowDays,
          sortOrder,
          active: form.active,
          isPublic: form.isPublic,
        };
        return api.adminUpdatePlan(form.id, patch);
      }
      const postBody: AdminPlanInput = {
        code: form.code.trim().toUpperCase(),
        nameFa: form.nameFa.trim(),
        descriptionFa: form.descriptionFa,
        priceRials,
        intervalMonths,
        quota,
        features,
        imageUrl: imageUrl.length > 0 ? imageUrl : null,
        discountPct,
        renewalDiscountPct,
        renewalDiscountWindowDays,
        sortOrder,
        active: form.active,
        isPublic: form.isPublic,
      };
      return api.adminCreatePlan(postBody);
    },
    onSuccess: () => {
      toast.success("طرح ذخیره شد.");
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ["admin", "plans"] });
      qc.invalidateQueries({ queryKey: ["public", "plans"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "ذخیره ناموفق بود."),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.adminDeletePlan(id),
    onSuccess: () => {
      toast.success("طرح غیرفعال شد.");
      setDeleteId(null);
      qc.invalidateQueries({ queryKey: ["admin", "plans"] });
      qc.invalidateQueries({ queryKey: ["public", "plans"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "حذف ناموفق بود."),
  });

  // ----- Image upload via /api/media-upload ---------------------------
  const imageUploadMut = useMutation({
    mutationFn: async (file: File) => api.uploadMedia(file, "image"),
    onSuccess: (r) => {
      // Store the auth-gated stream URL. Admin sees the thumbnail (they're
      // authenticated); for the public catalog page the URL still loads if
      // the admin pasted an absolute https URL instead.
      setForm((f) => ({ ...f, imageUrl: `/api/media/${r.id}` }));
      toast.success("تصویر بارگذاری شد.");
    },
    onError: (e: Error) => toast.error(e.message ?? "بارگذاری تصویر ناموفق بود."),
  });

  // ----- Derived live discount preview --------------------------------
  const discountedPriceFa = useMemo(() => {
    const price = Number(form.priceRials.replace(/[,٬]/g, ""));
    const pct = Number(form.discountPct);
    if (!Number.isFinite(price) || price < 0) return "";
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return "";
    const final = Math.round(price * (1 - pct / 100));
    return formatRials(final);
  }, [form.priceRials, form.discountPct]);

  // Client-side sort: by sortOrder asc, then priceRials asc. (The API
  // already returns this order, but we re-sort defensively so the UI
  // stays correct even after inline edits.)
  const plans = useMemo(() => {
    const arr = q.data?.items ? [...q.data.items] : [];
    arr.sort(
      (a, b) =>
        (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.priceRials - b.priceRials,
    );
    return arr;
  }, [q.data]);

  return (
    <div className="flex flex-col gap-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <PackageIcon className="size-6" />
            پلن‌ها
          </h1>
          <p className="text-sm text-muted-foreground">
            تعریف و مدیریت پلن‌های اشتراک با کنترل دقیق امکانات و تخفیف‌ها.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
            className="cursor-pointer"
          >
            <RefreshCwIcon className={`size-4 ${q.isFetching ? "animate-spin" : ""}`} />
            به‌روزرسانی
          </Button>
          <Button onClick={openCreate} className="cursor-pointer">
            <PlusIcon className="size-4" /> پلن جدید
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">
            فهرست پلن‌ها ({toPersianDigits(plans.length)})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {q.isLoading && (
            <div className="flex flex-col gap-2 p-3">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}
          {q.isError && !q.isLoading && (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-destructive">
              <AlertCircleIcon className="size-8" />
              <div>بارگذاری پلن‌ها ناموفق بود.</div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => q.refetch()}
                className="mt-2 cursor-pointer"
              >
                تلاش دوباره
              </Button>
            </div>
          )}
          {plans.length === 0 && !q.isLoading && !q.isError && (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
              <PackageIcon className="size-8 opacity-50" />
              <div>هیچ پلنی تعریف نشده است.</div>
              <Button
                variant="outline"
                size="sm"
                onClick={openCreate}
                className="mt-2 cursor-pointer"
              >
                <PlusIcon className="size-4" /> پلن جدید بسازید
              </Button>
            </div>
          )}
          {plans.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>کد</TableHead>
                    <TableHead>نام</TableHead>
                    <TableHead>مبلغ</TableHead>
                    <TableHead>بازه</TableHead>
                    <TableHead>امکانات</TableHead>
                    <TableHead>ترتیب</TableHead>
                    <TableHead>وضعیت</TableHead>
                    <TableHead className="text-left">عملیات</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plans.map((p) => {
                    const featCount = countEnabledFeatures(p.features);
                    const discountActive = (p.discountPct ?? 0) > 0;
                    const renewalActive = (p.renewalDiscountPct ?? 0) > 0;
                    return (
                      <TableRow key={p.id}>
                        <TableCell>
                          <PlanThumb
                            imageUrl={p.imageUrl}
                            nameFa={p.nameFa}
                            size={36}
                          />
                        </TableCell>
                        <TableCell dir="ltr" className="font-mono text-xs">
                          {p.code}
                        </TableCell>
                        <TableCell className="font-medium">{p.nameFa}</TableCell>
                        <TableCell className="text-xs">
                          {discountActive ? (
                            <div className="flex flex-col gap-0.5">
                              <span className="text-muted-foreground line-through tabular-nums">
                                {p.priceRialsFa ?? formatRials(p.priceRials)}
                              </span>
                              <span className="tabular-nums font-medium text-emerald-700 dark:text-emerald-400">
                                {formatRials(
                                  Math.round(
                                    p.priceRials * (1 - (p.discountPct ?? 0) / 100),
                                  ),
                                )}
                              </span>
                            </div>
                          ) : (
                            <span className="tabular-nums">
                              {p.priceRialsFa ?? formatRials(p.priceRials)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums text-xs">
                          {toPersianDigits(p.intervalMonths)} ماه
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge variant="secondary" className="text-xs">
                              {toPersianDigits(featCount)} امکان
                            </Badge>
                            {discountActive && (
                              <Badge variant="default" className="text-xs">
                                <TagIcon className="size-3" />
                                {toPersianDigits(p.discountPct ?? 0)}٪ تخفیف
                              </Badge>
                            )}
                            {renewalActive && (
                              <Badge variant="outline" className="text-xs">
                                تمدید: {toPersianDigits(p.renewalDiscountPct ?? 0)}٪
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min={0}
                            dir="ltr"
                            defaultValue={String(p.sortOrder ?? 0)}
                            className="h-8 w-16 text-center text-xs tabular-nums"
                            onBlur={(e) => {
                              const n = Number(e.target.value);
                              if (
                                Number.isFinite(n) &&
                                n >= 0 &&
                                n !== (p.sortOrder ?? 0)
                              ) {
                                setSortOrderMut.mutate({ id: p.id, sortOrder: n });
                              } else {
                                e.target.value = String(p.sortOrder ?? 0);
                              }
                            }}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <label className="flex items-center gap-2 text-xs">
                              <Switch
                                checked={p.active}
                                onCheckedChange={(v) =>
                                  toggleActiveMut.mutate({ id: p.id, active: v })
                                }
                                disabled={toggleActiveMut.isPending}
                              />
                              {p.active ? "فعال" : "غیرفعال"}
                            </label>
                            <div className="flex gap-1">
                              {p.isPublic ? (
                                <Badge variant="outline" className="text-xs">
                                  عمومی
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-xs">
                                  خصوصی
                                </Badge>
                              )}
                              <Badge variant="secondary" className="text-xs">
                                {toPersianDigits(p.subscriptionCount)} اشتراک
                              </Badge>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEdit(p)}
                              className="cursor-pointer"
                              aria-label="ویرایش"
                            >
                              <PencilIcon className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="cursor-pointer text-destructive hover:text-destructive"
                              onClick={() => setDeleteId(p.id)}
                              disabled={p.code === "free"}
                              aria-label="غیرفعال‌سازی"
                            >
                              <Trash2Icon className="size-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ===================== Create / Edit Dialog ===================== */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent dir="rtl" className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PackageIcon className="size-5" />
              {form.id ? "ویرایش پلن" : "پلن جدید"}
            </DialogTitle>
            <DialogDescription>
              امکانات اشتراک را دقیق انتخاب کنید و تخفیف‌ها را تنظیم کنید.
              تغییرات بلافاصله در صفحهٔ پلن‌ها برای کاربران نمایش داده می‌شود.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              saveMut.mutate();
            }}
          >
            {/* ---------- Basic fields ---------- */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="p-code">شناسهٔ پلن (انگلیسی)</Label>
                <Input
                  id="p-code"
                  dir="ltr"
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  disabled={!!form.id}
                  maxLength={40}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="p-name">نام اشتراک</Label>
                <Input
                  id="p-name"
                  value={form.nameFa}
                  onChange={(e) => setForm({ ...form, nameFa: e.target.value })}
                  maxLength={80}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="p-desc">توضیحات</Label>
              <Textarea
                id="p-desc"
                rows={2}
                value={form.descriptionFa}
                onChange={(e) => setForm({ ...form, descriptionFa: e.target.value })}
                maxLength={800}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="p-price">قیمت (ریال)</Label>
                <Input
                  id="p-price"
                  inputMode="numeric"
                  dir="ltr"
                  value={form.priceRials}
                  onChange={(e) => setForm({ ...form, priceRials: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="p-int">مدت اشتراک (ماه)</Label>
                <Input
                  id="p-int"
                  type="number"
                  min={1}
                  max={12}
                  dir="ltr"
                  value={form.intervalMonths}
                  onChange={(e) => setForm({ ...form, intervalMonths: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="p-sort">جایگاه در فهرست</Label>
                <Input
                  id="p-sort"
                  type="number"
                  min={0}
                  dir="ltr"
                  value={form.sortOrder}
                  onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                />
              </div>
            </div>

            {/* ---------- ITEM 33: Plan image ---------- */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="p-image">تصویر اشتراک</Label>
              <div className="flex flex-wrap items-center gap-3">
                <PlanThumb
                  imageUrl={form.imageUrl}
                  nameFa={form.nameFa || "?"}
                  size={64}
                />
                <Input
                  id="p-image"
                  dir="ltr"
                  placeholder="https://…  یا  /api/media/ID"
                  value={form.imageUrl}
                  onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
                  className="flex-1"
                />
                <input
                  id="p-image-file"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) imageUploadMut.mutate(f);
                    e.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => document.getElementById("p-image-file")?.click()}
                  disabled={imageUploadMut.isPending}
                  className="cursor-pointer"
                >
                  {imageUploadMut.isPending ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : (
                    <UploadCloudIcon className="size-4" />
                  )}
                  بارگذاری
                </Button>
                {form.imageUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setForm({ ...form, imageUrl: "" })}
                    className="cursor-pointer text-destructive hover:text-destructive"
                  >
                    حذف تصویر
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                می‌توانید یک URL عمومی وارد کنید یا فایلی را بارگذاری نمایید.
                پیش‌نمایش در سمت راست نشان داده می‌شود.
              </p>
            </div>

            {/* ---------- ITEM 32: Discount ---------- */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="p-disc">درصد تخفیف (٪)</Label>
                <Input
                  id="p-disc"
                  type="number"
                  min={0}
                  max={100}
                  dir="ltr"
                  value={form.discountPct}
                  onChange={(e) => setForm({ ...form, discountPct: e.target.value })}
                />
              </div>
              <div className="flex flex-col justify-end gap-1.5">
                <Label>پیش‌نمایش</Label>
                <div className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-xs">
                  {discountedPriceFa ? (
                    <span>
                      قیمت با تخفیف:{" "}
                      <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                        {discountedPriceFa}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      بدون تخفیف — مبلغ کامل نمایش داده می‌شود.
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* ---------- ITEM 34: Renewal discount ---------- */}
            <Card className="border-dashed">
              <CardHeader className="pb-2 pt-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <TagIcon className="size-4" />
                  تخفیف برای تمدید زودهنگام
                </CardTitle>
                <CardDescription className="text-xs">
                  اگر کاربر اشتراک خود را قبل از پایان آن تمدید کند، این تخفیف اعمال می‌شود.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="p-rdp">درصد تخفیف تمدید (٪)</Label>
                  <Input
                    id="p-rdp"
                    type="number"
                    min={0}
                    max={100}
                    dir="ltr"
                    value={form.renewalDiscountPct}
                    onChange={(e) =>
                      setForm({ ...form, renewalDiscountPct: e.target.value })
                    }
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="p-rw">مدت زمانی قبل از پایان (روز)</Label>
                  <Input
                    id="p-rw"
                    type="number"
                    min={0}
                    max={365}
                    dir="ltr"
                    value={form.renewalDiscountWindowDays}
                    onChange={(e) =>
                      setForm({ ...form, renewalDiscountWindowDays: e.target.value })
                    }
                  />
                </div>
                <p className="col-span-full text-xs text-muted-foreground">
                  اگر کاربر تا{" "}
                  <span className="font-semibold">
                    {toPersianDigits(Number(form.renewalDiscountWindowDays) || 0)}
                  </span>{" "}
                  روز قبل از پایان اشتراک تمدید کند،{" "}
                  <span className="font-semibold">
                    {toPersianDigits(Number(form.renewalDiscountPct) || 0)}٪
                  </span>{" "}
                  تخفیف اعمال می‌شود.
                </p>
              </CardContent>
            </Card>

            {/* ---------- ITEM 31: Granular features ---------- */}
            <div className="flex flex-col gap-1.5">
              <Label>امکانات این اشتراک</Label>
              <Accordion
                type="multiple"
                defaultValue={["publishing", "ai"]}
                className="rounded-md border"
              >
                {FEATURE_CATALOG.map((group) => (
                  <AccordionItem key={group.id} value={group.id}>
                    <AccordionTrigger className="px-3 cursor-pointer">
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{group.title}</span>
                        <Badge variant="secondary" className="text-xs">
                          {toPersianDigits(
                            group.items.filter((d) => {
                              const v = form.features[d.key];
                              return d.type === "boolean"
                                ? v === true
                                : typeof v === "number" && v > 0;
                            }).length,
                          )}{" "}
                          از {toPersianDigits(group.items.length)}
                        </Badge>
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="px-3">
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {group.items.map((def) => (
                          <FeatureRow
                            key={def.key}
                            def={def}
                            value={form.features[def.key]}
                            onChange={(v) =>
                              setForm((f) => ({
                                ...f,
                                features: { ...f.features, [def.key]: v },
                              }))
                            }
                          />
                        ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </div>

            {/* ---------- Legacy quota JSON (advanced) ---------- */}
            <details className="rounded-md border border-dashed p-3 text-sm">
              <summary className="cursor-pointer font-medium text-muted-foreground">
                تنظیمات پیشرفته (فقط برای سازگاری با نسخه‌های قدیمی)
              </summary>
              <Textarea
                rows={5}
                dir="ltr"
                className="mt-2 font-mono text-xs"
                value={form.quotaJson}
                onChange={(e) => setForm({ ...form, quotaJson: e.target.value })}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                این قسمت فقط برای سازگاری با نسخه‌های قدیمی است. تنظیم امکانات بالا
                منبع اصلی کنترل دسترسی ماژول‌هاست.
              </p>
            </details>

            {/* ---------- Toggles ---------- */}
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={form.active}
                  onCheckedChange={(v) => setForm({ ...form, active: v })}
                />
                فعال
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={form.isPublic}
                  onCheckedChange={(v) => setForm({ ...form, isPublic: v })}
                />
                عمومی
              </label>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowForm(false)}
                className="cursor-pointer"
              >
                انصراف
              </Button>
              <Button
                type="submit"
                disabled={
                  saveMut.isPending ||
                  (form.id ? false : form.code.trim().length < 2) ||
                  form.nameFa.trim().length < 2
                }
                className="cursor-pointer"
              >
                {saveMut.isPending ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <SaveIcon className="size-4" />
                )}
                ذخیره
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ===================== Delete confirm ===================== */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>غیرفعال‌سازی پلن</AlertDialogTitle>
            <AlertDialogDescription>
              پلن به‌جای حذف قطعی، غیرفعال و خصوصی می‌شود تا اشتراک‌های فعال
              دست‌نخورده بمانند.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">انصراف</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 cursor-pointer"
              onClick={() => deleteId && deleteMut.mutate(deleteId)}
            >
              غیرفعال کن
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// =====================================================================
// PlanThumb — image thumbnail or first-letter placeholder.
// =====================================================================
function PlanThumb({
  imageUrl,
  nameFa,
  size,
}: {
  imageUrl: string | null | undefined;
  nameFa: string;
  size: number;
}) {
  const px = `${size}px`;
  if (imageUrl && imageUrl.trim().length > 0) {
    return (
      <img
        src={imageUrl}
        alt={nameFa}
        width={size}
        height={size}
        className="rounded-md border object-cover"
        style={{ width: px, height: px }}
        loading="lazy"
      />
    );
  }
  const letter = (nameFa || "?").trim().charAt(0) || "?";
  return (
    <div
      className="flex items-center justify-center rounded-md border bg-muted text-muted-foreground font-semibold"
      style={{ width: px, height: px, fontSize: `${Math.round(size * 0.45)}px` }}
      aria-label={nameFa || "بدون نام"}
    >
      {letter}
    </div>
  );
}

// =====================================================================
// FeatureRow — one row of the feature catalog. Boolean => Checkbox +
// label; numeric => label + number Input.
// =====================================================================
function FeatureRow({
  def,
  value,
  onChange,
}: {
  def: PlanFeatureDef;
  value: boolean | number | undefined;
  onChange: (v: boolean | number) => void;
}) {
  const isBool = def.type === "boolean" || isBooleanFeature(def.key as PlanFeatureKey);
  if (isBool) {
    const checked = value === true;
    return (
      <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/60 focus-within:ring-2 focus-visible:ring-ring/40">
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => onChange(v === true)}
          className="cursor-pointer"
        />
        <span>{def.label}</span>
      </label>
    );
  }
  const n =
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return (
    <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm">
      <Label htmlFor={`feat-${def.key}`} className="cursor-pointer">
        {def.label}
      </Label>
      <div className="flex items-center gap-1">
        <Input
          id={`feat-${def.key}`}
          type="number"
          min={0}
          dir="ltr"
          value={n}
          onChange={(e) => {
            const v = Number(e.target.value);
            onChange(Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
          }}
          className="h-8 w-20 text-center text-xs tabular-nums"
        />
        <span className="text-xs text-muted-foreground">۰ = نامحدود</span>
      </div>
    </div>
  );
}

export function AdminPlansView(props: AdminPlansViewProps) {
  return (
    <AdminGate>
      <AdminPlansInner {...props} />
    </AdminGate>
  );
}

export default AdminPlansView;
