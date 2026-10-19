// Nhận cấu hình quyền do máy chủ sở hữu, không nhận vai trò từ trình duyệt.
// Quản trị bao phủ mọi lớp Handout được mở; giáo viên cũ mặc định giữ quyền theo lớp.
export function teacherRole(account){
  const role=account.role===undefined?'teacher':account.role;
  if(!['teacher','admin'].includes(role))throw new Error('TEACHER_REGISTRY_INVALID');
  return role;
}

export function hasTeacherClass(account,classRef){
  return teacherRole(account)==='admin'||account.classes.includes(classRef);
}

export function validateTeacherRegistry(value,allowedClasses){
  if(!value||typeof value.clientId!=='string'||!value.clientId.endsWith('.apps.googleusercontent.com')||!Array.isArray(value.teachers))throw new Error('TEACHER_REGISTRY_INVALID');
  for(const account of value.teachers){
    if(!account||typeof account.email!=='string'||typeof account.displayName!=='string'||typeof account.subject!=='string'||!account.subject.trim()||!Array.isArray(account.classes)||account.classes.some(c=>typeof c!=='string'||!c.trim()))throw new Error('TEACHER_REGISTRY_INVALID');
    if(teacherRole(account)==='teacher'&&account.classes.some(c=>!allowedClasses.includes(c)))throw new Error('TEACHER_REGISTRY_INVALID');
  }
  return value;
}
