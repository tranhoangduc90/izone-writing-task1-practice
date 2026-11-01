/** Chỉ trạng thái công khai; không mang transcript, prompt hoặc phản hồi AI ra stream. */
export function readingPracticeView(row){
 return row?{id:row.id,url:row.share_url,status:row.status,message:row.outcome?.message||({queued:'Đã lưu link, đang chờ kiểm tra.',processing:'Đang đọc và kiểm tra hội thoại.',needs_review:'Chưa rõ kết quả kiểm. Link đã được giữ để đối soát.',retry:'Chưa đọc được hội thoại. Bạn có thể thử lại.'}[row.status]||''),updatedAt:row.updated_at}:{url:'',status:'not_started',message:'Dán link chia sẻ sau khi luyện xong.'};
}
