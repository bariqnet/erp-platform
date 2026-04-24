// Minimal translation strings for the console. Full i18next integration
// lands when the console grows beyond a handful of screens.

export type Locale = "en" | "ar";

const STRINGS = {
  en: {
    app_title: "ERP Platform",
    entities: "Entities",
    nav_metadata: "Metadata",
    nav_changes: "Changes",
    login_title: "Sign in",
    login_email: "Email",
    login_password: "Password",
    login_tenant: "Tenant id",
    login_tenant_hint: "e.g. t_demo_retail. Membership is required.",
    login_submit: "Sign in",
    logout: "Sign out",
    list_title: "Rows",
    list_row_id: "Row id",
    list_status: "Status",
    list_created: "Created",
    list_updated: "Updated",
    list_open: "Open",
    list_none: "No rows yet.",
    list_new: "+ New",
    new_title: "New row",
    new_hint:
      "Required fields are marked with *. Shape is derived from the entity's current metadata.",
    new_submit: "Create",
    new_saving: "Creating…",
    new_cancel: "Cancel",
    new_error: "Create failed.",
    detail_body: "Body",
    detail_save: "Save",
    detail_saved: "Saved.",
    detail_saving: "Saving…",
    detail_error: "Save failed.",
    detail_back: "Back to list",
    detail_delete: "Delete",
    detail_deleted: "Deleted.",
    locale_toggle: "عربي",
    session_banner_as: "tenant",
  },
  ar: {
    app_title: "منصة تخطيط موارد المؤسسات",
    entities: "الكيانات",
    nav_metadata: "البيانات الوصفية",
    nav_changes: "التغييرات",
    login_title: "تسجيل الدخول",
    login_email: "البريد الإلكتروني",
    login_password: "كلمة المرور",
    login_tenant: "معرّف المستأجر",
    login_tenant_hint: "مثل t_demo_retail. العضوية مطلوبة.",
    login_submit: "تسجيل الدخول",
    logout: "خروج",
    list_title: "السجلات",
    list_row_id: "المعرّف",
    list_status: "الحالة",
    list_created: "أُنشئ",
    list_updated: "حُدّث",
    list_open: "فتح",
    list_none: "لا توجد سجلات بعد.",
    list_new: "+ جديد",
    new_title: "سجل جديد",
    new_hint: "الحقول المطلوبة مميّزة بـ *. البنية مشتقّة من البيانات الوصفية الحالية للكيان.",
    new_submit: "إنشاء",
    new_saving: "جارٍ الإنشاء…",
    new_cancel: "إلغاء",
    new_error: "فشل الإنشاء.",
    detail_body: "المحتوى",
    detail_save: "حفظ",
    detail_saved: "تم الحفظ.",
    detail_saving: "جارٍ الحفظ…",
    detail_error: "فشل الحفظ.",
    detail_back: "العودة إلى القائمة",
    detail_delete: "حذف",
    detail_deleted: "تم الحذف.",
    locale_toggle: "English",
    session_banner_as: "المستأجر",
  },
} as const;

export type StringKey = keyof (typeof STRINGS)["en"];

export function t(locale: Locale, key: StringKey): string {
  return STRINGS[locale][key];
}

export function localeDir(locale: Locale): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}
