// Minimal translation strings for the console. Full i18next integration
// lands when the console grows beyond a handful of screens.

export type Locale = "en" | "ar";

const STRINGS = {
  en: {
    app_title: "ERP Platform",
    entities: "Entities",
    login_title: "Sign in",
    login_tenant: "Tenant id",
    login_user: "User id",
    login_roles: "Roles",
    login_roles_hint: "Comma-separated, e.g. prm.admin",
    login_submit: "Sign in",
    logout: "Sign out",
    list_title: "Rows",
    list_row_id: "Row id",
    list_status: "Status",
    list_created: "Created",
    list_updated: "Updated",
    list_open: "Open",
    list_none: "No rows yet.",
    detail_body: "Body",
    detail_save: "Save",
    detail_saved: "Saved.",
    detail_saving: "Saving…",
    detail_error: "Save failed.",
    detail_back: "Back to list",
    detail_delete: "Delete",
    detail_deleted: "Deleted.",
    locale_toggle: "عربي",
    session_banner_prefix: "Signed in as",
    session_banner_as: "as",
  },
  ar: {
    app_title: "منصة تخطيط موارد المؤسسات",
    entities: "الكيانات",
    login_title: "تسجيل الدخول",
    login_tenant: "معرّف المستأجر",
    login_user: "معرّف المستخدم",
    login_roles: "الأدوار",
    login_roles_hint: "مفصولة بفواصل، مثل prm.admin",
    login_submit: "تسجيل الدخول",
    logout: "خروج",
    list_title: "السجلات",
    list_row_id: "المعرّف",
    list_status: "الحالة",
    list_created: "أُنشئ",
    list_updated: "حُدّث",
    list_open: "فتح",
    list_none: "لا توجد سجلات بعد.",
    detail_body: "المحتوى",
    detail_save: "حفظ",
    detail_saved: "تم الحفظ.",
    detail_saving: "جارٍ الحفظ…",
    detail_error: "فشل الحفظ.",
    detail_back: "العودة إلى القائمة",
    detail_delete: "حذف",
    detail_deleted: "تم الحذف.",
    locale_toggle: "English",
    session_banner_prefix: "مسجّل الدخول باسم",
    session_banner_as: "كـ",
  },
} as const;

export type StringKey = keyof (typeof STRINGS)["en"];

export function t(locale: Locale, key: StringKey): string {
  return STRINGS[locale][key];
}

export function localeDir(locale: Locale): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}
