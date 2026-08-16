// Dữ liệu nhận vào: mã HTTP từ API quản trị sau khi Google đã trả thông tin đăng nhập.
// Việc chính: phân biệt hết phiên (401) với tài khoản không có quyền (403).
// Kết quả: thông báo rõ để giao diện đưa giảng viên về màn hình chọn tài khoản;
// các lỗi mạng/hệ thống khác trả null để dashboard tiếp tục thử lại.
export function teacherAuthFailure(status) {
  if (status === 401) {
    return {
      header: "Chưa đăng nhập",
      message: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.",
    };
  }
  if (status === 403) {
    return {
      header: "Tài khoản chưa có quyền",
      message: "Tài khoản Google này chưa được cấp quyền xem dashboard của lớp. Hãy chọn tài khoản quản trị đã được cấp quyền.",
    };
  }
  return null;
}
