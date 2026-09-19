// Nhận vào: trạng thái đối chiếu lớp từ API Writing.
// Việc chính: đổi mã kỹ thuật thành câu ngắn để người vận hành biết lớp nào cần xử lý.
// Trả ra: nhãn trạng thái và mô tả; không nhận hoặc hiển thị dữ liệu học viên.
// Khi gặp trạng thái mới: hiển thị mã gốc để không che thông tin cần debug.
export const coverageStatusLabels = {
  covered: 'Đã có trong nguồn chấm',
  missing_source: 'Thiếu trong nguồn chấm',
  mapping_issue: 'Mapping lớp chưa đủ',
  unexpected_source: 'Có trong nguồn nhưng chưa thuộc danh sách vận hành',
  excluded: 'Đã loại khỏi chấm',
  class_code_missing: 'Không đọc được mã lớp',
};

export function coverageDescription(row) {
  if (row.status === 'missing_source') return 'Lớp đang vận hành nhưng chưa xuất hiện trong lượt quét Writing gần nhất.';
  if (row.status === 'mapping_issue') return 'Lớp đang vận hành nhưng nguồn ERP hoặc Classroom chưa khớp đầy đủ.';
  if (row.status === 'unexpected_source') return 'Nguồn homework có lớp này nhưng danh sách lớp đang vận hành chưa có.';
  if (row.status === 'excluded') return 'IC2288 được loại theo quy tắc đã duyệt và không được gửi chấm.';
  if (row.status === 'class_code_missing') return 'Tên lớp trong mapping không có mã IC/CS nhận biết được.';
  return 'Lớp đang vận hành đã xuất hiện trong lượt quét Writing gần nhất.';
}
